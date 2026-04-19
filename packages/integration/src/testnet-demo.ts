/**
 * Testnet demo: verify a Counter contract on Arb Sepolia, propagate to Base Sepolia,
 * anchoring the proof on Sepolia L1.  Uses real Pinata IPFS.
 *
 * Required env vars (from .env.testnet):
 *   L1_RPC_URL, PRIVATE_KEY, PINATA_JWT, IPFS_GATEWAY,
 *   ARB_SEPOLIA_RPC, BASE_SEPOLIA_RPC, REGISTRY_ADDRESS
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type InterfaceAbi,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  concat,
  getCreate2Address,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import solc from "solc";

import {
  PinataIpfsClient,
  compileSolidity,
  computeCodeHash,
  getCompiledContract,
  lookup,
  propagate,
  type SolidityStandardJsonInput,
  verify,
} from "@cross-l2-verify/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const COUNTER_SOURCE_PATH = "examples/sample-contract/Counter.sol";
const CREATE2_FACTORY_SOURCE_PATH = "packages/integration/src/Create2Factory.sol";

// ---- env ----
const L1_RPC_URL = process.env.L1_RPC_URL ?? "";
const ARB_SEPOLIA_RPC = process.env.ARB_SEPOLIA_RPC ?? "";
const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC ?? "";
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const PINATA_JWT = process.env.PINATA_JWT ?? "";
const IPFS_GATEWAY = process.env.IPFS_GATEWAY ?? "https://gateway.pinata.cloud/ipfs";
const REGISTRY_ADDRESS = process.env.REGISTRY_ADDRESS ?? "";

for (const [k, v] of Object.entries({ L1_RPC_URL, ARB_SEPOLIA_RPC, BASE_SEPOLIA_RPC, PRIVATE_KEY, PINATA_JWT, REGISTRY_ADDRESS })) {
  if (!v) throw new Error(`Missing env var: ${k}`);
}

// Nick's deterministic CREATE2 factory — same address on all EVM chains
const NICK_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

interface CompiledArtifact {
  abi: InterfaceAbi;
  bytecode: `0x${string}`;
  compilerInput: SolidityStandardJsonInput;
}

function normalizeBytecode(hex: string): `0x${string}` {
  return (hex.startsWith("0x") ? hex : `0x${hex}`) as `0x${string}`;
}

async function compileFromFile(pathFromRoot: string, contractName: string): Promise<CompiledArtifact> {
  const source = await readFile(resolve(REPO_ROOT, pathFromRoot), "utf8");
  return compileFromSource(pathFromRoot, source, contractName);
}

async function compileFromSource(sourcePath: string, source: string, contractName: string): Promise<CompiledArtifact> {
  const compilerInput: SolidityStandardJsonInput = {
    language: "Solidity",
    sources: { [sourcePath]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const compilerOutput = await compileSolidity(compilerInput);
  const contract = getCompiledContract(compilerOutput, sourcePath, contractName);
  if (!contract.abi || !contract.evm?.bytecode?.object) throw new Error(`Missing ABI/bytecode for ${contractName}`);
  return { abi: contract.abi as InterfaceAbi, bytecode: normalizeBytecode(contract.evm.bytecode.object), compilerInput };
}


async function main() {
  console.log("=== Cross-L2 Verify — Testnet Demo ===\n");

  const l1Provider  = new JsonRpcProvider(L1_RPC_URL);
  const arbProvider = new JsonRpcProvider(ARB_SEPOLIA_RPC);
  const baseProvider = new JsonRpcProvider(BASE_SEPOLIA_RPC);

  const l1Wallet   = new NonceManager(new Wallet(PRIVATE_KEY, l1Provider));
  const arbWallet  = new NonceManager(new Wallet(PRIVATE_KEY, arbProvider));
  const baseWallet = new NonceManager(new Wallet(PRIVATE_KEY, baseProvider));

  const deployer = new Wallet(PRIVATE_KEY).address;
  console.log("Deployer:", deployer);
  console.log("Registry:", REGISTRY_ADDRESS, "(Sepolia)\n");

  // ── 1. Compile ──────────────────────────────────────────────────────────────
  console.log("Step 1: Compiling Counter...");
  const counterArtifact = await compileFromFile(COUNTER_SOURCE_PATH, "Counter");
  console.log("  Compiler:", solc.version());

  // ── 2. Compute Counter CREATE2 address using Nick's factory ──────────────
  console.log("\nStep 2: Computing Counter CREATE2 address via Nick's factory...");
  const saltSeed = process.env.DEMO_SALT ?? "cross-l2-verify-testnet-demo-v1";
  const salt = keccak256(toUtf8Bytes(saltSeed));
  console.log("  Salt seed:", saltSeed);
  const counterAddr = getCreate2Address(NICK_FACTORY, salt, keccak256(counterArtifact.bytecode));
  console.log("  Counter address:", counterAddr, "(same on all chains)");
  console.log("  Nick's factory:", NICK_FACTORY);

  // ── 3. Deploy Counter via CREATE2 on both L2s ────────────────────────────
  console.log("\nStep 3: Deploying Counter via CREATE2 on Arb Sepolia and Base Sepolia...");
  // Nick's factory calldata = salt (32 bytes) + initCode
  const deployCalldata = concat([salt, counterArtifact.bytecode]);

  async function deployViaFactory(wallet: NonceManager, provider: JsonRpcProvider, chainName: string) {
    const existing = await provider.getCode(counterAddr);
    if (existing !== "0x") { console.log("  Already deployed on", chainName); return; }
    const tx = await wallet.sendTransaction({ to: NICK_FACTORY, data: deployCalldata });
    await tx.wait();
    console.log("  Deployed on", chainName, "tx:", tx.hash);
  }

  await deployViaFactory(arbWallet, arbProvider, "Arb Sepolia");
  await deployViaFactory(baseWallet, baseProvider, "Base Sepolia");

  const counterAddrArb  = counterAddr;
  const counterAddrBase = counterAddr;

  async function waitForCode(provider: JsonRpcProvider, addr: string, label: string) {
    for (let i = 0; i < 10; i++) {
      const code = await provider.getCode(addr);
      if (code !== "0x") return;
      await new Promise(r => setTimeout(r, 3000));
    }
    throw new Error(`Timeout waiting for code at ${addr} on ${label}`);
  }
  await Promise.all([
    waitForCode(arbProvider, counterAddrArb, "Arb Sepolia"),
    waitForCode(baseProvider, counterAddrBase, "Base Sepolia"),
  ]);
  console.log("  Deployed on both chains ✓");

  // ── 4. Verify on Arb Sepolia, anchor proof on Sepolia L1 ─────────────────
  console.log("\nStep 4: Verifying Counter on Arb Sepolia (anchoring on Sepolia L1)...");
  const ipfsClient = new PinataIpfsClient({ jwt: PINATA_JWT, gatewayUrl: IPFS_GATEWAY });
  const compilerVersion = solc.version();

  const verificationResult = await verify({
    compilerInput: counterArtifact.compilerInput,
    compilerVersion,
    contractPath: COUNTER_SOURCE_PATH,
    contractName: "Counter",
    targetChainId: 421614,
    targetAddress: counterAddrArb,
    targetProvider: arbProvider,
    registryAddress: REGISTRY_ADDRESS,
    registryRunner: l1Wallet,
    ipfsClient,
    pinName: "counter-proof-testnet",
  });

  console.log("  Code Hash:", verificationResult.codeHash);
  console.log("  Proof Hash:", verificationResult.proofHash);
  console.log("  IPFS CID:", verificationResult.cid);
  console.log("  Tx:", verificationResult.transactionHash);

  // ── 5. Propagate to Base Sepolia ─────────────────────────────────────────
  console.log("\nStep 5: Propagating to Base Sepolia...");
  const propagationResult = await propagate({
    registryAddress: REGISTRY_ADDRESS,
    registryRunner: l1Wallet,
    targetProvider: baseProvider,
    targetAddress: counterAddrBase,
    targetChainId: 84532,
    expectedCodeHash: verificationResult.codeHash,
  });
  console.log("  Propagation tx:", propagationResult.transactionHash);

  // ── 6. Lookup ────────────────────────────────────────────────────────────
  console.log("\nStep 6: Looking up by code hash...");
  const found = await lookup({
    kind: "codeHash",
    codeHash: verificationResult.codeHash,
    registryAddress: REGISTRY_ADDRESS,
    registryRunner: l1Provider,
    ipfsClient,
  });
  console.log("  Chains in registry:", found.chainIds);
  assert.ok(found.chainIds.includes(421614), "Arb Sepolia not in registry");
  assert.ok(found.chainIds.includes(84532),  "Base Sepolia not in registry");

  console.log("\n✓ All steps passed.");
  console.log("\n=== Summary ===");
  console.log("  Registry:      ", REGISTRY_ADDRESS, "(Sepolia)");
  console.log("  Counter:       ", counterAddrArb, "(Arb Sepolia + Base Sepolia)");
  console.log("  Code Hash:     ", verificationResult.codeHash);
  console.log("  IPFS CID:      ", verificationResult.cid);
  console.log("  Proof Hash:    ", verificationResult.proofHash);
}

main().catch((e) => { console.error(e); process.exit(1); });
