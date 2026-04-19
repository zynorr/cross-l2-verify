/**
 * Bulk importer: fetches recently verified contracts from Blockscout across
 * Arb Sepolia, Base Sepolia, and OP Sepolia, then submits each to the
 * cross-l2-verify registry via the SDK.
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
 *
 * Usage:
 *   pnpm --filter @cross-l2-verify/integration bulk-import
 */

import { JsonRpcProvider, NonceManager, Wallet } from "ethers";

import {
  PinataIpfsClient,
  verify,
  computeCodeHash,
  type SolidityStandardJsonInput,
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
const LIMIT            = Math.min(200, Math.max(1, Number(process.env.LIMIT ?? "50")));
const CONCURRENCY      = Math.min(5, Math.max(1, Number(process.env.CONCURRENCY ?? "2")));
const CHAIN_IDS        = (process.env.CHAIN_IDS ?? "84532,421614,11155420")
  .split(",").map(s => Number(s.trim())).filter(Boolean);

for (const [k, v] of Object.entries({ L1_RPC_URL, REGISTRY_ADDRESS, PRIVATE_KEY, PINATA_JWT })) {
  if (!v) throw new Error(`Missing env var: ${k}`);
}

// ---------------------------------------------------------------------------
// Blockscout V2 types
// ---------------------------------------------------------------------------

interface BlockscoutListItem {
  address: { hash: string };
  name: string;
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
  if (!info) throw new Error(`No Blockscout config for chain ${chainId}`);

  const results: Array<{ address: string; name: string; compilerVersion: string }> = [];
  let nextPageParams: Record<string, unknown> | null = null;

  while (results.length < limit) {
    // Blockscout uses cursor-based pagination via next_page_params
    const params = new URLSearchParams();
    if (nextPageParams) {
      for (const [k, v] of Object.entries(nextPageParams)) {
        params.set(k, String(v));
      }
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
        name: item.name,
        compilerVersion: item.compiler_version,
      });
      if (results.length >= limit) break;
    }

    if (!data.next_page_params || results.length >= limit) break;
    nextPageParams = data.next_page_params;

    // Be polite to the API
    await sleep(300);
  }

  return results;
}

async function fetchContractDetail(
  chainId: number,
  address: string,
): Promise<BlockscoutContractDetail | null> {
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

  // Build sources map
  const sources: Record<string, { content: string }> = {
    [contractPath]: { content: detail.source_code },
  };
  for (const extra of detail.additional_sources ?? []) {
    sources[extra.file_path] = { content: extra.source_code };
  }

  // Build settings
  const settings: Record<string, unknown> = {
    ...(detail.compiler_settings ?? {}),
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
    },
  };

  const compilerInput: SolidityStandardJsonInput = {
    language: "Solidity",
    sources,
    settings,
  };

  return { compilerInput, contractPath, compilerVersion };
}

function normalizeVersion(v: string): string {
  // "v0.8.26+commit.8a97fa7a" → "0.8.26"
  return v.replace(/^v/, "").replace(/\+.*$/, "");
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface Stats {
  total: number;
  verified: number;
  skipped: number;
  failed: number;
  chains: Record<string, { verified: number; failed: number }>;
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
  console.log(`Registry:     ${REGISTRY_ADDRESS}`);
  console.log();

  const l1Provider = new JsonRpcProvider(L1_RPC_URL);
  const l1Wallet = new NonceManager(new Wallet(PRIVATE_KEY, l1Provider));
  const ipfsClient = new PinataIpfsClient({ jwt: PINATA_JWT, gatewayUrl: IPFS_GATEWAY });

  const stats: Stats = { total: 0, verified: 0, skipped: 0, failed: 0, chains: {} };

  for (const chainId of CHAIN_IDS) {
    const chainInfo = BLOCKSCOUT[chainId];
    if (!chainInfo) {
      console.warn(`No Blockscout config for chain ${chainId}, skipping.`);
      continue;
    }

    console.log(`\n── ${chainInfo.name} (${chainId}) ──────────────────────────`);
    stats.chains[chainInfo.name] = { verified: 0, failed: 0 };

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

    // Process in batches of CONCURRENCY
    for (let i = 0; i < contracts.length; i += CONCURRENCY) {
      const batch = contracts.slice(i, i + CONCURRENCY);
      await Promise.allSettled(
        batch.map(c => importContract({
          chainId,
          chainInfo,
          contract: c,
          targetProvider,
          l1Provider,
          l1Wallet,
          ipfsClient,
          stats,
        }))
      );
    }

    console.log(`\n  ${chainInfo.name} done: ${stats.chains[chainInfo.name].verified} verified, ${stats.chains[chainInfo.name].failed} failed`);
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log("Summary");
  console.log(`  Total processed: ${stats.total}`);
  console.log(`  Verified:        ${stats.verified}`);
  console.log(`  Skipped:         ${stats.skipped}`);
  console.log(`  Failed:          ${stats.failed}`);
  for (const [chain, s] of Object.entries(stats.chains)) {
    console.log(`  ${chain}: ${s.verified} verified, ${s.failed} failed`);
  }
}

interface ImportContractOptions {
  chainId: number;
  chainInfo: { name: string; api: string; rpc: string };
  contract: { address: string; name: string; compilerVersion: string };
  targetProvider: JsonRpcProvider;
  l1Provider: JsonRpcProvider;
  l1Wallet: NonceManager;
  ipfsClient: PinataIpfsClient;
  stats: Stats;
}

async function importContract(opts: ImportContractOptions): Promise<void> {
  const { chainId, chainInfo, contract, targetProvider, l1Wallet, ipfsClient, stats } = opts;
  const label = `${contract.name} @ ${contract.address.slice(0, 10)}... (${chainInfo.name})`;
  stats.total++;

  try {
    // 1. Fetch full source detail
    const detail = await fetchContractDetail(chainId, contract.address);
    if (!detail || !detail.is_verified || !detail.source_code) {
      console.log(`  ⊘  ${label} — no source`);
      stats.skipped++;
      return;
    }

    if (detail.language?.toLowerCase() !== "solidity") {
      console.log(`  ⊘  ${label} — ${detail.language ?? "unknown"} (skipped)`);
      stats.skipped++;
      return;
    }

    // 2. Build compiler input
    let compilerInput: SolidityStandardJsonInput;
    let contractPath: string;
    let compilerVersion: string;
    try {
      ({ compilerInput, contractPath, compilerVersion } = buildCompilerInput(detail));
    } catch (err) {
      console.log(`  ✗  ${label} — build input failed: ${errorMessage(err)}`);
      stats.failed++;
      stats.chains[chainInfo.name].failed++;
      return;
    }

    if (DRY_RUN) {
      console.log(`  ○  ${label} — dry run (would submit compiler v${compilerVersion})`);
      stats.verified++;
      stats.chains[chainInfo.name].verified++;
      return;
    }

    // 3. Submit via SDK
    const result = await verify({
      compilerInput,
      compilerVersion,
      contractPath,
      contractName: detail.name,
      targetChainId: chainId,
      targetAddress: contract.address,
      targetProvider,
      registryAddress: REGISTRY_ADDRESS,
      registryRunner: l1Wallet,
      ipfsClient,
      pinName: `${detail.name}-${chainId}-bulk`,
    });

    console.log(`  ✓  ${label}`);
    console.log(`      codeHash:  ${result.codeHash}`);
    console.log(`      proofHash: ${result.proofHash}`);
    console.log(`      IPFS CID:  ${result.cid}`);
    stats.verified++;
    stats.chains[chainInfo.name].verified++;

    // Small delay to avoid L1 nonce issues
    await sleep(2_000);

  } catch (err) {
    const msg = errorMessage(err);

    // "proof exists" means it's already in our registry — not a failure
    if (msg.includes("proof exists") || msg.includes("deployment exists")) {
      console.log(`  ✓  ${label} — already registered`);
      stats.skipped++;
      return;
    }

    // Bytecode mismatch — common for proxies, abstract contracts, or metadata differences
    if (msg.includes("does not match")) {
      console.log(`  ⊘  ${label} — bytecode mismatch (proxy or partial match)`);
      stats.skipped++;
      return;
    }

    console.log(`  ✗  ${label} — ${msg.slice(0, 100)}`);
    stats.failed++;
    stats.chains[chainInfo.name].failed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch(e => { console.error(e); process.exit(1); });
