import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Contract,
  ContractFactory,
  type ContractRunner,
  type InterfaceAbi,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  getAddress,
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
  type IpfsPinClient,
  type PinJsonResult,
  type SolidityStandardJsonInput,
  type VerificationProof,
  verify,
} from "@cross-l2-verify/sdk";

interface NetworkConfig {
  name: string;
  chainId: number;
  port: number;
}

interface CompiledArtifact {
  abi: InterfaceAbi;
  bytecode: `0x${string}`;
  compilerInput: SolidityStandardJsonInput;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const REGISTRY_SOURCE_PATH = "packages/contracts/src/VerificationRegistry.sol";
const COUNTER_SOURCE_PATH = "examples/sample-contract/Counter.sol";
const CREATE2_FACTORY_SOURCE_PATH = "packages/integration/src/Create2Factory.sol";

const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const NETWORK_TEMPLATES: NetworkConfig[] = [
  { name: "l1", chainId: 31337, port: 8545 },
  { name: "l2-a", chainId: 421614, port: 9545 },
  { name: "l2-b", chainId: 84532, port: 10545 },
];

const CREATE2_FACTORY_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

contract Create2Factory {
    event Deployed(address deployment);

    function deploy(bytes32 salt, bytes memory creationCode) external payable returns (address deployment) {
        assembly {
            deployment := create2(callvalue(), add(creationCode, 0x20), mload(creationCode), salt)
        }
        require(deployment != address(0), "create2 failed");
        emit Deployed(deployment);
    }

    function computeAddress(bytes32 salt, bytes32 creationCodeHash) external view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), salt, creationCodeHash)
                    )
                )
            )
        );
    }
}
`;

const DRY_RUN = process.argv.includes("--dry-run");
const KEEP_ALIVE = process.argv.includes("--keep-alive");
const REQUIRE_LIVE_IPFS = process.argv.includes("--require-live-ipfs");

async function runDemo(): Promise<void> {
  const networks = await allocateNetworks();
  const processes: ChildProcess[] = [];

  try {
    for (const network of networks) {
      processes.push(startAnvil(network));
      await waitForRpc(network.port);
    }

    const l1Provider = new JsonRpcProvider(rpcUrl(networks[0]));
    const l2AProvider = new JsonRpcProvider(rpcUrl(networks[1]));
    const l2BProvider = new JsonRpcProvider(rpcUrl(networks[2]));

    const l1Wallet = new NonceManager(new Wallet(ANVIL_PRIVATE_KEY, l1Provider));
    const l2AWallet = new NonceManager(new Wallet(ANVIL_PRIVATE_KEY, l2AProvider));
    const l2BWallet = new NonceManager(new Wallet(ANVIL_PRIVATE_KEY, l2BProvider));

    const registryArtifact = await compileFromFile(REGISTRY_SOURCE_PATH, "VerificationRegistry");
    const counterArtifact = await compileFromFile(COUNTER_SOURCE_PATH, "Counter");
    const create2FactoryArtifact = await compileFromSource(
      CREATE2_FACTORY_SOURCE_PATH,
      CREATE2_FACTORY_SOURCE,
      "Create2Factory",
    );

    const registry = await deployContract(registryArtifact, l1Wallet);
    const factoryA = await deployContract(create2FactoryArtifact, l2AWallet);
    const factoryB = await deployContract(create2FactoryArtifact, l2BWallet);

    const factoryAddressA = await factoryA.getAddress();
    const factoryAddressB = await factoryB.getAddress();
    assert.equal(factoryAddressA, factoryAddressB, "Factory address should match across both L2s");

    const salt = keccak256(toUtf8Bytes("cross-l2-verify-demo"));
    const counterCreationCode = counterArtifact.bytecode;
    const counterCreationCodeHash = keccak256(counterCreationCode);

    const counterAddressA = getAddress(
      await factoryA.computeAddress(salt, counterCreationCodeHash),
    );
    const counterAddressB = getAddress(
      await factoryB.computeAddress(salt, counterCreationCodeHash),
    );

    await waitForTransaction(await factoryA.deploy(salt, counterCreationCode));
    await waitForTransaction(await factoryB.deploy(salt, counterCreationCode));

    assert.equal(counterAddressA, counterAddressB, "CREATE2 deployment should match across both L2s");
    assert.notEqual(await l2AProvider.getCode(counterAddressA), "0x", "L2-A deployment missing");
    assert.notEqual(await l2BProvider.getCode(counterAddressB), "0x", "L2-B deployment missing");

    const { client: ipfsClient, mode: ipfsMode } = createDemoIpfsClient();
    const compilerVersion = solc.version();

    const verificationResult = await verify({
      compilerInput: counterArtifact.compilerInput,
      compilerVersion,
      contractPath: COUNTER_SOURCE_PATH,
      contractName: "Counter",
      targetChainId: networks[1].chainId,
      targetAddress: counterAddressA,
      targetProvider: l2AProvider,
      registryAddress: await registry.getAddress(),
      registryRunner: l1Wallet,
      ipfsClient,
      pinName: "counter-proof",
    });

    const propagationResult = await propagate({
      registryAddress: await registry.getAddress(),
      registryRunner: l1Wallet,
      targetProvider: l2BProvider,
      targetAddress: counterAddressB,
      targetChainId: networks[2].chainId,
      expectedCodeHash: verificationResult.codeHash,
    });

    const lookupByAddress = await lookup({
      kind: "address",
      targetProvider: l2AProvider,
      targetAddress: counterAddressA,
      targetChainId: networks[1].chainId,
      registryAddress: await registry.getAddress(),
      registryRunner: l1Provider,
      ipfsClient,
    });

    const lookupByCodeHash = await lookup({
      kind: "codeHash",
      codeHash: verificationResult.codeHash,
      registryAddress: await registry.getAddress(),
      registryRunner: l1Provider,
      ipfsClient,
    });

    assert.equal(lookupByAddress.proofs.length, 1, "Expected one anchored proof");
    assert.equal(lookupByCodeHash.proofs.length, 1, "Expected one proof for the code hash");
    assert.deepEqual(
      [...lookupByCodeHash.chainIds].sort((lhs, rhs) => lhs - rhs),
      [networks[2].chainId, networks[1].chainId].sort((lhs, rhs) => lhs - rhs),
      "Expected deployments on both L2s",
    );
    assert.equal(
      computeCodeHash(await l2AProvider.getCode(counterAddressA)),
      verificationResult.codeHash,
      "Onchain bytecode hash should match the anchored proof",
    );
    assert.equal(propagationResult.codeHash, verificationResult.codeHash);

    printJson({
      mode: KEEP_ALIVE ? "keep-alive" : "test",
      ipfsMode,
      networks,
      registryAddress: await registry.getAddress(),
      factoryAddress: factoryAddressA,
      counterAddress: counterAddressA,
      verificationResult,
      propagationResult,
      lookupByAddress,
      lookupByCodeHash,
    });

    if (KEEP_ALIVE) {
      console.log("Demo networks are running. Press Ctrl+C to stop them.");
      await waitForTerminationSignal();
    }
  } finally {
    for (const processHandle of processes) {
      processHandle.kill("SIGTERM");
    }
  }
}

function plannedSteps(): string[] {
  return [
    "Start 3 local Anvil chains: one L1 registry chain and two simulated L2s.",
    "Compile and deploy VerificationRegistry to the L1 chain.",
    "Deploy a shared CREATE2 factory to both L2s from the same signer.",
    "Deploy the sample Counter contract with the same salt on both L2s so the address matches.",
    "Verify the L2-A deployment once and anchor the proof on L1 using Pinata/IPFS when configured, with a local fallback for repeatable tests.",
    "Propagate the same code hash to the L2-B deployment without resubmitting source.",
    "Lookup by address and by code hash to prove both L2 deployments resolve from one anchored proof.",
  ];
}

async function compileFromFile(pathFromRepoRoot: string, contractName: string): Promise<CompiledArtifact> {
  const source = await readFile(resolve(REPO_ROOT, pathFromRepoRoot), "utf8");
  return compileFromSource(pathFromRepoRoot, source, contractName);
}

async function compileFromSource(
  sourcePath: string,
  source: string,
  contractName: string,
): Promise<CompiledArtifact> {
  const compilerInput: SolidityStandardJsonInput = {
    language: "Solidity",
    sources: {
      [sourcePath]: {
        content: source,
      },
    },
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
        },
      },
    },
  };

  const compilerOutput = await compileSolidity(compilerInput);
  const contract = getCompiledContract(compilerOutput, sourcePath, contractName);

  if (!contract.abi || !contract.evm?.bytecode?.object) {
    throw new Error(`Missing ABI or bytecode for ${contractName}`);
  }

  return {
    abi: contract.abi as InterfaceAbi,
    bytecode: normalizeBytecode(contract.evm.bytecode.object),
    compilerInput,
  };
}

async function deployContract(artifact: CompiledArtifact, wallet: ContractRunner): Promise<Contract> {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();
  await contract.waitForDeployment();
  return contract as unknown as Contract;
}

async function waitForTransaction(tx: { wait: () => Promise<unknown> }): Promise<void> {
  await tx.wait();
}

async function allocateNetworks(): Promise<NetworkConfig[]> {
  return Promise.all(
    NETWORK_TEMPLATES.map(async (network) => ({
      ...network,
      port: await reservePort(network.port),
    })),
  );
}

function startAnvil(network: NetworkConfig): ChildProcess {
  return spawn(
    "anvil",
    [
      "--port",
      String(network.port),
      "--chain-id",
      String(network.chainId),
      "--silent",
    ],
    {
      stdio: "ignore",
    },
  );
}

function rpcUrl(network: NetworkConfig): string {
  return `http://127.0.0.1:${network.port}`;
}

async function waitForRpc(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });

      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the Anvil instance is ready.
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for Anvil on port ${port}`);
}

async function reservePort(preferredPort: number): Promise<number> {
  try {
    return await tryReservePort(preferredPort);
  } catch {
    return tryReservePort(0);
  }
}

async function tryReservePort(port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve port")));
        return;
      }

      const reservedPort = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(reservedPort);
      });
    });
  });
}

async function waitForTerminationSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSignal = () => resolve();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeBytecode(bytecode: string): `0x${string}` {
  const prefixed = bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`;
  return prefixed.toLowerCase() as `0x${string}`;
}

function printJson(value: unknown): void {
  console.log(
    JSON.stringify(
      value,
      (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
      2,
    ),
  );
}

class LocalProofStore implements IpfsPinClient {
  private readonly proofs = new Map<string, VerificationProof>();

  async pinJson(payload: unknown): Promise<PinJsonResult> {
    const serialized = JSON.stringify(payload);
    const cid = `local-${createHash("sha256").update(serialized).digest("hex")}`;
    this.proofs.set(cid, structuredClone(payload) as VerificationProof);
    return {
      cid,
      gatewayUrl: `local://${cid}`,
    };
  }

  async fetchJson<T>(cid: string): Promise<T> {
    const proof = this.proofs.get(cid);
    if (!proof) {
      throw new Error(`Missing proof for CID ${cid}`);
    }

    return structuredClone(proof) as T;
  }
}

function createDemoIpfsClient(): {
  client: IpfsPinClient;
  mode: "pinata" | "memory-fallback";
} {
  const pinataJwt = process.env.PINATA_JWT;
  const gatewayUrl = process.env.IPFS_GATEWAY;

  if (!pinataJwt) {
    if (REQUIRE_LIVE_IPFS) {
      throw new Error("PINATA_JWT is required when --require-live-ipfs is set");
    }

    return {
      client: new LocalProofStore(),
      mode: "memory-fallback",
    };
  }

  return {
    client: new ResilientPinataProofStore(
      new PinataIpfsClient({
        jwt: pinataJwt,
        gatewayUrl,
      }),
    ),
    mode: "pinata",
  };
}

class ResilientPinataProofStore implements IpfsPinClient {
  private readonly cache = new Map<string, VerificationProof>();

  constructor(
    private readonly remote: PinataIpfsClient,
    private readonly maxAttempts = 5,
    private readonly retryDelayMs = 1_500,
  ) {}

  async pinJson(payload: unknown, options?: { name?: string }): Promise<PinJsonResult> {
    const result = await this.remote.pinJson(payload, options);
    this.cache.set(result.cid, structuredClone(payload) as VerificationProof);
    return result;
  }

  async fetchJson<T>(cid: string): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.remote.fetchJson<T>(cid);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts) {
          await sleep(this.retryDelayMs);
        }
      }
    }

    const cached = this.cache.get(cid);
    if (cached) {
      return structuredClone(cached) as T;
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

if (DRY_RUN) {
  printJson({
    mode: "dry-run",
    networks: NETWORK_TEMPLATES,
    plannedSteps: plannedSteps(),
  });
} else {
  await runDemo();
}
