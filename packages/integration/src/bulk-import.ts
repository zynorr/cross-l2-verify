/**
 * Bulk importer: fetches recently verified contracts from Blockscout across
 * Arb Sepolia, Base Sepolia, and OP Sepolia, then submits each to the
 * cross-l2-verify registry via the SDK.
 *
 * Supports both full bytecode matches and partial matches (where only the
 * CBOR metadata suffix differs — the Sourcify "partial match" model).
 *
 * Required env vars (from .env.testnet):
 *   L1_RPC_URL, REGISTRY_ADDRESS, PRIVATE_KEY, PINATA_JWT
 *
 * Optional:
 *   IPFS_GATEWAY     (default: https://gateway.pinata.cloud/ipfs)
 *   CHAIN_IDS        comma-separated chain IDs to import from (default: 84532,421614,11155420)
 *   LIMIT            max contracts per chain (default: 50, max: 200)
 *   CONCURRENCY      parallel verify submissions (default: 2)
 *   DRY_RUN          if "true", compile and match but skip on-chain submission
 *   FULL_ONLY        if "true", skip partial matches (require exact bytecode match)
 *
 * Usage:
 *   pnpm --filter @cross-l2-verify/integration bulk-import
 *   pnpm --filter @cross-l2-verify/integration bulk-import:dry
 */

import { Contract, JsonRpcProvider, NonceManager, Wallet, getAddress } from "ethers";

import {
  VERIFICATION_REGISTRY_ABI,
  PinataIpfsClient,
  VerificationProofSchema,
  computeCodeHash,
  computeProofHash,
  computeSourceHash,
  normalizeHex,
  compileSolidity,
  getCompiledContract,
  type SolidityStandardJsonInput,
  type VerificationProof,
} from "@cross-l2-verify/sdk";

// ---------------------------------------------------------------------------
// Blockscout instances per chain
// ---------------------------------------------------------------------------

const BLOCKSCOUT: Record<number, { api: string; name: string; rpc: string }> = {
  84532: {
    name: "Base Sepolia",
    api: "https://base-sepolia.blockscout.com",
    rpc: "https://sepolia.base.org",
  },
  421614: {
    name: "Arb Sepolia",
    api: "https://arbitrum-sepolia.blockscout.com",
    rpc: "https://sepolia-rollup.arbitrum.io/rpc",
  },
  11155420: {
    name: "OP Sepolia",
    api: "https://optimism-sepolia.blockscout.com",
    rpc: "https://sepolia.optimism.io",
  },
};

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const L1_RPC_URL       = process.env.L1_RPC_URL ?? "";
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS ?? "";
const PRIVATE_KEY      = process.env.PRIVATE_KEY ?? "";
const PINATA_JWT       = process.env.PINATA_JWT ?? "";
const IPFS_GATEWAY     = process.env.IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs";
const DRY_RUN          = process.env.DRY_RUN === "true";
const FULL_ONLY        = process.env.FULL_ONLY === "true";
const LIMIT            = Math.min(200, Math.max(1, Number(process.env.LIMIT ?? "50")));
const CONCURRENCY      = Math.min(5, Math.max(1, Number(process.env.CONCURRENCY ?? "2")));
const CHAIN_IDS        = (process.env.CHAIN_IDS ?? "84532,421614,11155420")
  .split(",").map(s => Number(s.trim())).filter(Boolean);

for (const [k, v] of Object.entries({ L1_RPC_URL, REGISTRY_ADDRESS, PRIVATE_KEY, PINATA_JWT })) {
  if (!v) throw new Error(`Missing env var: ${k}`);
}

// ---------------------------------------------------------------------------
// CBOR metadata stripping (Sourcify-style partial match)
// ---------------------------------------------------------------------------

/**
 * Strip the CBOR-encoded metadata appended to Solidity compiled bytecode.
 * The last 2 bytes encode the length of the CBOR block (big-endian uint16).
 * Returns the bytecode without the metadata suffix, or the original if
 * the suffix looks malformed.
 */
function stripCborMetadata(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = Buffer.from(clean, "hex");
  if (bytes.length < 4) return hex;

  const metaLen = bytes.readUInt16BE(bytes.length - 2);
  // Sanity: metadata must fit within the bytecode and be at least 2 bytes
  if (metaLen < 2 || metaLen + 2 > bytes.length) return hex;

  return "0x" + bytes.slice(0, bytes.length - metaLen - 2).toString("hex");
}

type MatchKind = "full" | "partial" | "none";

function matchBytecode(compiled: string, deployed: string): MatchKind {
  const c = normalizeHex(compiled);
  const d = normalizeHex(deployed);
  if (c === d) return "full";
  if (stripCborMetadata(c) === stripCborMetadata(d)) return "partial";
  return "none";
}

// ---------------------------------------------------------------------------
// Blockscout V2 types
// ---------------------------------------------------------------------------

interface BlockscoutListItem {
  address: { hash: string; name: string | null };
  name?: string;
  language: string;
  compiler_version: string;
}

interface BlockscoutListResponse {
  items: BlockscoutListItem[];
  next_page_params: Record<string, unknown> | null;
}

interface BlockscoutContractDetail {
  name: string;
  compiler_version: string;
  source_code: string;
  file_path: string;
  language: string;
  additional_sources: Array<{ file_path: string; source_code: string }>;
  compiler_settings: Record<string, unknown>;
  is_verified: boolean;
}

// ---------------------------------------------------------------------------
// Blockscout helpers
// ---------------------------------------------------------------------------

async function listVerifiedContracts(
  chainId: number,
  limit: number,
): Promise<Array<{ address: string; name: string; compilerVersion: string }>> {
  const info = BLOCKSCOUT[chainId];
  const results: Array<{ address: string; name: string; compilerVersion: string }> = [];
  let nextPageParams: Record<string, unknown> | null = null;

  while (results.length < limit) {
    const params = new URLSearchParams();
    if (nextPageParams) {
      for (const [k, v] of Object.entries(nextPageParams)) params.set(k, String(v));
    }
    const qs = params.toString();
    const url = `${info.api}/api/v2/smart-contracts${qs ? `?${qs}` : ""}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`Blockscout list failed ${resp.status}: ${url}`);
    const data = (await resp.json()) as BlockscoutListResponse;

    for (const item of data.items) {
      if (item.language?.toLowerCase() !== "solidity") continue;
      results.push({
        address: item.address.hash,
        name: item.address.name ?? item.name ?? "Unknown",
        compilerVersion: item.compiler_version,
      });
      if (results.length >= limit) break;
    }

    if (!data.next_page_params || results.length >= limit) break;
    nextPageParams = data.next_page_params;
    await sleep(300);
  }
  return results;
}

async function fetchContractDetail(chainId: number, address: string): Promise<BlockscoutContractDetail | null> {
  const info = BLOCKSCOUT[chainId];
  const url = `${info.api}/api/v2/smart-contracts/${address}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Blockscout detail failed ${resp.status}: ${url}`);
  return resp.json() as Promise<BlockscoutContractDetail>;
}

function buildCompilerInput(detail: BlockscoutContractDetail): {
  compilerInput: SolidityStandardJsonInput;
  contractPath: string;
  compilerVersion: string;
} {
  const contractPath = detail.file_path || `${detail.name}.sol`;
  const compilerVersion = normalizeVersion(detail.compiler_version);

  const sources: Record<string, { content: string }> = {
    [contractPath]: { content: detail.source_code },
  };
  for (const extra of detail.additional_sources ?? []) {
    sources[extra.file_path] = { content: extra.source_code };
  }

  const settings: Record<string, unknown> = {
    ...(detail.compiler_settings ?? {}),
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
    },
  };

  return {
    compilerInput: { language: "Solidity", sources, settings },
    contractPath,
    compilerVersion,
  };
}

function normalizeVersion(v: string): string {
  return v.replace(/^v/, "").replace(/\+.*$/, "");
}

// ---------------------------------------------------------------------------
// Manual proof submission (used for partial matches)
// ---------------------------------------------------------------------------

interface ManualVerifyOptions {
  compilerInput: SolidityStandardJsonInput;
  compilerVersion: string;
  contractPath: string;
  contractName: string;
  targetChainId: number;
  targetAddress: string;
  /** The deployed bytecode (from eth_getCode) — used as codeHash source */
  deployedRuntimeBytecode: string;
  /** The compiled creation bytecode */
  compiledCreationBytecode: string;
  matchKind: MatchKind;
  registryAddress: string;
  registryRunner: NonceManager;
  ipfsClient: PinataIpfsClient;
  pinName?: string;
}

async function submitProofManually(opts: ManualVerifyOptions): Promise<{
  codeHash: string; sourceHash: string; proofHash: string; cid: string; txHash?: string;
}> {
  const {
    compilerInput, compilerVersion, contractPath, contractName,
    targetChainId, targetAddress, deployedRuntimeBytecode, compiledCreationBytecode,
    registryAddress, registryRunner, ipfsClient,
  } = opts;

  // codeHash is always of the DEPLOYED bytecode (what users query by address)
  const deployed = normalizeHex(deployedRuntimeBytecode);
  const codeHash = computeCodeHash(deployed);
  const sourceHash = computeSourceHash(compilerInput);

  const unsignedProof = {
    proofVersion: "1" as const,
    language: "Solidity" as const,
    contract: { path: contractPath, name: contractName },
    compiler: { version: compilerVersion, settings: compilerInput.settings },
    sourceBundle: compilerInput,
    artifacts: {
      creationBytecode: normalizeHex(compiledCreationBytecode),
      creationBytecodeHash: computeCodeHash(compiledCreationBytecode),
      runtimeBytecode: deployed,
      runtimeBytecodeHash: codeHash,
    },
    attestation: { codeHash, sourceHash },
    deployments: [{ chainId: targetChainId, address: getAddress(targetAddress) }],
    metadata: {
      createdAt: new Date().toISOString(),
      tooling: { sdk: "@cross-l2-verify/sdk@0.1.0" },
    },
  };

  const proofHash = computeProofHash(unsignedProof);
  const proof: VerificationProof = VerificationProofSchema.parse({
    ...unsignedProof,
    attestation: { ...unsignedProof.attestation, proofHash },
  });

  const { cid } = await ipfsClient.pinJson(proof, {
    name: opts.pinName ?? `${contractName}-${proofHash.slice(0, 16)}`,
  });

  const registry = new Contract(getAddress(registryAddress), VERIFICATION_REGISTRY_ABI, registryRunner);
  const tx = await registry.submitProofAndRegister(
    proofHash, codeHash, sourceHash, compilerVersion, cid,
    BigInt(targetChainId), getAddress(targetAddress),
  );
  const receipt = await tx.wait();

  return { codeHash, sourceHash, proofHash, cid, txHash: receipt?.hash };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface ChainStats { full: number; partial: number; skipped: number; failed: number; }
interface Stats {
  total: number;
  full: number;
  partial: number;
  skipped: number;
  failed: number;
  chains: Record<string, ChainStats>;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== cross-l2-verify Bulk Importer ===\n");
  console.log(`Chains:       ${CHAIN_IDS.map(id => BLOCKSCOUT[id]?.name ?? id).join(", ")}`);
  console.log(`Limit:        ${LIMIT} contracts per chain`);
  console.log(`Concurrency:  ${CONCURRENCY}`);
  console.log(`Dry run:      ${DRY_RUN}`);
  console.log(`Full only:    ${FULL_ONLY}`);
  console.log(`Registry:     ${REGISTRY_ADDRESS}`);
  console.log();

  const l1Provider = new JsonRpcProvider(L1_RPC_URL);
  const l1Wallet = new NonceManager(new Wallet(PRIVATE_KEY, l1Provider));
  const ipfsClient = new PinataIpfsClient({ jwt: PINATA_JWT, gatewayUrl: IPFS_GATEWAY });

  const stats: Stats = { total: 0, full: 0, partial: 0, skipped: 0, failed: 0, chains: {} };

  for (const chainId of CHAIN_IDS) {
    const chainInfo = BLOCKSCOUT[chainId];
    if (!chainInfo) { console.warn(`No Blockscout config for chain ${chainId}`); continue; }

    console.log(`\n── ${chainInfo.name} (${chainId}) ──────────────────────────`);
    stats.chains[chainInfo.name] = { full: 0, partial: 0, skipped: 0, failed: 0 };

    let contracts: Array<{ address: string; name: string; compilerVersion: string }>;
    try {
      process.stdout.write(`  Fetching verified contracts list...`);
      contracts = await listVerifiedContracts(chainId, LIMIT);
      console.log(` ${contracts.length} found`);
    } catch (err) {
      console.error(`\n  Failed to list contracts: ${errorMessage(err)}`);
      continue;
    }

    const targetProvider = new JsonRpcProvider(chainInfo.rpc);

    for (let i = 0; i < contracts.length; i += CONCURRENCY) {
      const batch = contracts.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(c => importContract({
          chainId, chainInfo, contract: c,
          targetProvider, l1Wallet, ipfsClient, stats,
        }))
      );
    }

    const cs = stats.chains[chainInfo.name];
    console.log(`\n  ${chainInfo.name} done: ${cs.full} full, ${cs.partial} partial, ${cs.skipped} skipped, ${cs.failed} failed`);
  }

  const totalImported = stats.full + stats.partial;
  console.log("\n═══════════════════════════════════════════════════");
  console.log("Summary");
  console.log(`  Total processed:  ${stats.total}`);
  console.log(`  Imported:         ${totalImported} (${stats.full} full + ${stats.partial} partial)`);
  console.log(`  Skipped:          ${stats.skipped}`);
  console.log(`  Failed:           ${stats.failed}`);
  for (const [chain, s] of Object.entries(stats.chains)) {
    const imp = s.full + s.partial;
    console.log(`  ${chain}: ${imp} imported (${s.full}F+${s.partial}P), ${s.skipped} skipped, ${s.failed} failed`);
  }
}

interface ImportContractOptions {
  chainId: number;
  chainInfo: { name: string; api: string; rpc: string };
  contract: { address: string; name: string; compilerVersion: string };
  targetProvider: JsonRpcProvider;
  l1Wallet: NonceManager;
  ipfsClient: PinataIpfsClient;
  stats: Stats;
}

async function importContract(opts: ImportContractOptions): Promise<void> {
  const { chainId, chainInfo, contract, targetProvider, l1Wallet, ipfsClient, stats } = opts;
  const label = `${contract.name} @ ${contract.address.slice(0, 10)}… (${chainInfo.name})`;
  stats.total++;
  const cs = stats.chains[chainInfo.name];

  try {
    // 1. Fetch source detail
    const detail = await fetchContractDetail(chainId, contract.address);
    if (!detail?.is_verified || !detail.source_code) {
      console.log(`  ⊘  ${label} — no source`);
      stats.skipped++; cs.skipped++; return;
    }
    if (detail.language?.toLowerCase() !== "solidity") {
      console.log(`  ⊘  ${label} — ${detail.language ?? "unknown"}`);
      stats.skipped++; cs.skipped++; return;
    }

    // 2. Build compiler input
    let compilerInput: SolidityStandardJsonInput, contractPath: string, compilerVersion: string;
    try {
      ({ compilerInput, contractPath, compilerVersion } = buildCompilerInput(detail));
    } catch (err) {
      console.log(`  ✗  ${label} — build input: ${errorMessage(err)}`);
      stats.failed++; cs.failed++; return;
    }

    // 3. Compile
    let compiledRuntime: string, compiledCreation: string;
    try {
      const output = await compileSolidity(compilerInput);
      const compiled = getCompiledContract(output, contractPath, detail.name);
      compiledRuntime = "0x" + (compiled.evm?.deployedBytecode?.object ?? "");
      compiledCreation = "0x" + (compiled.evm?.bytecode?.object ?? "");
      if (compiledRuntime === "0x") throw new Error("empty compiled runtime");
    } catch (err) {
      console.log(`  ✗  ${label} — compile: ${errorMessage(err).slice(0, 80)}`);
      stats.failed++; cs.failed++; return;
    }

    // 4. Fetch deployed bytecode
    const deployedRuntime = await targetProvider.getCode(getAddress(contract.address));
    if (!deployedRuntime || deployedRuntime === "0x") {
      console.log(`  ⊘  ${label} — no deployed code`);
      stats.skipped++; cs.skipped++; return;
    }

    // 5. Check match
    const match = matchBytecode(compiledRuntime, deployedRuntime);
    if (match === "none") {
      console.log(`  ⊘  ${label} — bytecode mismatch`);
      stats.skipped++; cs.skipped++; return;
    }
    if (match === "partial" && FULL_ONLY) {
      console.log(`  ⊘  ${label} — partial match (FULL_ONLY set)`);
      stats.skipped++; cs.skipped++; return;
    }

    const matchLabel = match === "full" ? "✓ " : "~✓";

    if (DRY_RUN) {
      console.log(`  ${matchLabel} ${label} — dry run (${match} match, compiler v${compilerVersion})`);
      if (match === "full") { stats.full++; cs.full++; } else { stats.partial++; cs.partial++; }
      return;
    }

    // 6. Submit proof
    const result = await submitProofManually({
      compilerInput, compilerVersion, contractPath,
      contractName: detail.name,
      targetChainId: chainId,
      targetAddress: contract.address,
      deployedRuntimeBytecode: deployedRuntime,
      compiledCreationBytecode: compiledCreation,
      matchKind: match,
      registryAddress: REGISTRY_ADDRESS,
      registryRunner: l1Wallet,
      ipfsClient,
      pinName: `${detail.name}-${chainId}-bulk`,
    });

    console.log(`  ${matchLabel} ${label} (${match})`);
    console.log(`      codeHash:  ${result.codeHash}`);
    console.log(`      proofHash: ${result.proofHash}`);
    console.log(`      tx:        ${result.txHash}`);

    if (match === "full") { stats.full++; cs.full++; } else { stats.partial++; cs.partial++; }
    await sleep(1_500);

  } catch (err) {
    const msg = errorMessage(err);
    if (msg.includes("proof exists") || msg.includes("deployment exists")) {
      console.log(`  ✓  ${label} — already registered`);
      stats.skipped++; cs.skipped++; return;
    }
    console.log(`  ✗  ${label} — ${msg.slice(0, 100)}`);
    stats.failed++; cs.failed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch(e => { console.error(e); process.exit(1); });
