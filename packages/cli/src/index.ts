#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { Command } from "commander";
import { JsonRpcProvider, Wallet } from "ethers";

import {
  PinataIpfsClient,
  lookup as lookupVerification,
  propagate,
  verify,
  verifyOrPropagate,
  type LookupOptions,
  type SolidityStandardJsonInput,
} from "@cross-l2-verify/sdk";

import { resolveFoundryHookInput, resolveHardhatHookInput } from "./hooks.js";

const program = new Command();

program.name("cross-l2-verify").description("Cross-L2 contract verification prototype CLI").version("0.1.0");

program
  .command("verify")
  .requiredOption("--input <path>", "Path to a Solidity standard-json compiler input file")
  .requiredOption("--contract-path <path>", "Contract path inside the compiler input")
  .requiredOption("--contract-name <name>", "Contract name inside the compiler input")
  .requiredOption("--address <address>", "Target deployed contract address")
  .requiredOption("--chain-id <chainId>", "Target chain id", parsePositiveInteger)
  .requiredOption("--target-rpc <url>", "RPC URL for the target L2")
  .requiredOption("--l1-rpc <url>", "Ethereum L1 RPC URL")
  .requiredOption("--registry <address>", "VerificationRegistry address on L1")
  .requiredOption("--compiler-version <version>", "solc version used for compilation")
  .option("--private-key <hex>", "Private key for L1 submissions", process.env.PRIVATE_KEY)
  .option("--pinata-jwt <jwt>", "Pinata JWT for proof pinning", process.env.PINATA_JWT)
  .option("--pin-name <name>", "Optional Pinata pin name")
  .option("--ipfs-gateway <url>", "IPFS gateway URL", process.env.IPFS_GATEWAY)
  .action(
    wrapAction(async (options) => {
      const compilerInput = await readCompilerInput(options.input);
      const l1Provider = new JsonRpcProvider(options.l1Rpc);
      const registrySigner = new Wallet(
        requiredString(options.privateKey, "A private key is required for verify"),
        l1Provider,
      );
      const ipfsClient = new PinataIpfsClient({
        jwt: requiredString(options.pinataJwt, "A Pinata JWT is required for verify"),
        gatewayUrl: options.ipfsGateway,
      });

      const result = await verify({
        compilerInput,
        compilerVersion: options.compilerVersion,
        contractPath: options.contractPath,
        contractName: options.contractName,
        targetChainId: options.chainId,
        targetAddress: options.address,
        targetProvider: new JsonRpcProvider(options.targetRpc),
        registryAddress: options.registry,
        registryRunner: registrySigner,
        ipfsClient,
        pinName: options.pinName,
      });

      writeJson(result);
    }),
  );

program
  .command("hook:foundry")
  .requiredOption("--broadcast-file <path>", "Foundry broadcast JSON path")
  .requiredOption("--input <path>", "Path to a Solidity standard-json compiler input file")
  .requiredOption("--contract-name <name>", "Contract name to extract from the broadcast file")
  .requiredOption("--contract-path <path>", "Contract path inside the compiler input")
  .requiredOption("--target-rpc <url>", "RPC URL for the target L2")
  .requiredOption("--l1-rpc <url>", "Ethereum L1 RPC URL")
  .requiredOption("--registry <address>", "VerificationRegistry address on L1")
  .requiredOption("--compiler-version <version>", "solc version used for compilation")
  .option("--address <address>", "Override deployment address instead of inferring it from the broadcast file")
  .option("--chain-id <chainId>", "Override chain id instead of inferring it from the broadcast file", parsePositiveInteger)
  .option("--private-key <hex>", "Private key for L1 submissions", process.env.PRIVATE_KEY)
  .option("--pinata-jwt <jwt>", "Pinata JWT for proof pinning", process.env.PINATA_JWT)
  .option("--pin-name <name>", "Optional Pinata pin name")
  .option("--ipfs-gateway <url>", "IPFS gateway URL", process.env.IPFS_GATEWAY)
  .action(
    wrapAction(async (options) => {
      const [broadcast, compilerInput] = await Promise.all([
        readJsonFile(options.broadcastFile),
        readCompilerInput(options.input),
      ]);
      const deployment = resolveFoundryHookInput({
        broadcast,
        contractName: options.contractName,
        address: options.address,
        chainId: options.chainId,
      });

      const result = await submitVerificationWithFallback({
        compilerInput,
        compilerVersion: options.compilerVersion,
        contractPath: options.contractPath,
        contractName: options.contractName,
        targetChainId: deployment.chainId,
        targetAddress: deployment.address,
        targetRpc: options.targetRpc,
        l1Rpc: options.l1Rpc,
        registry: options.registry,
        privateKey: options.privateKey,
        pinataJwt: options.pinataJwt,
        pinName: options.pinName,
        ipfsGateway: options.ipfsGateway,
      });

      writeJson(result);
    }),
  );

program
  .command("hook:hardhat")
  .requiredOption("--build-info <path>", "Hardhat build-info JSON path")
  .requiredOption("--contract-name <name>", "Contract name inside the build-info output")
  .requiredOption("--target-rpc <url>", "RPC URL for the target L2")
  .requiredOption("--l1-rpc <url>", "Ethereum L1 RPC URL")
  .requiredOption("--registry <address>", "VerificationRegistry address on L1")
  .option("--contract-path <path>", "Contract path inside the build-info output")
  .option("--deployment-file <path>", "Deployment JSON path, for example from hardhat-deploy")
  .option("--address <address>", "Override deployment address")
  .option("--chain-id <chainId>", "Override chain id", parsePositiveInteger)
  .option("--private-key <hex>", "Private key for L1 submissions", process.env.PRIVATE_KEY)
  .option("--pinata-jwt <jwt>", "Pinata JWT for proof pinning", process.env.PINATA_JWT)
  .option("--pin-name <name>", "Optional Pinata pin name")
  .option("--ipfs-gateway <url>", "IPFS gateway URL", process.env.IPFS_GATEWAY)
  .action(
    wrapAction(async (options) => {
      const [buildInfo, deployment] = await Promise.all([
        readJsonFile(options.buildInfo),
        options.deploymentFile ? readJsonFile(options.deploymentFile) : Promise.resolve(undefined),
      ]);

      const resolution = resolveHardhatHookInput({
        buildInfo,
        contractName: options.contractName,
        contractPath: options.contractPath,
        deployment,
        address: options.address,
        chainId: options.chainId,
      });

      const result = await submitVerificationWithFallback({
        compilerInput: resolution.compilerInput,
        compilerVersion: resolution.compilerVersion,
        contractPath: resolution.contractPath,
        contractName: options.contractName,
        targetChainId: resolution.chainId,
        targetAddress: resolution.address,
        targetRpc: options.targetRpc,
        l1Rpc: options.l1Rpc,
        registry: options.registry,
        privateKey: options.privateKey,
        pinataJwt: options.pinataJwt,
        pinName: options.pinName,
        ipfsGateway: options.ipfsGateway,
      });

      writeJson(result);
    }),
  );

program
  .command("lookup")
  .requiredOption("--l1-rpc <url>", "Ethereum L1 RPC URL")
  .requiredOption("--registry <address>", "VerificationRegistry address on L1")
  .option("--address <address>", "Target deployed contract address")
  .option("--chain-id <chainId>", "Target chain id for address lookups", parsePositiveInteger)
  .option("--target-rpc <url>", "RPC URL for the target L2")
  .option("--code-hash <hash>", "Lookup by runtime bytecode hash instead of address")
  .option("--ipfs-gateway <url>", "IPFS gateway URL", process.env.IPFS_GATEWAY)
  .action(
    wrapAction(async (options) => {
      const lookupOptions = createLookupOptions(options);
      const result = await lookupVerification(lookupOptions);
      writeJson(result);
    }),
  );

program
  .command("propagate")
  .requiredOption("--l1-rpc <url>", "Ethereum L1 RPC URL")
  .requiredOption("--registry <address>", "VerificationRegistry address on L1")
  .requiredOption("--target-rpc <url>", "RPC URL for the target L2")
  .requiredOption("--address <address>", "Target deployed contract address")
  .requiredOption("--chain-id <chainId>", "Target chain id", parsePositiveInteger)
  .option("--expected-code-hash <hash>", "Optional expected runtime bytecode hash")
  .option("--private-key <hex>", "Private key for L1 submissions", process.env.PRIVATE_KEY)
  .action(
    wrapAction(async (options) => {
      const l1Provider = new JsonRpcProvider(options.l1Rpc);
      const registrySigner = new Wallet(
        requiredString(options.privateKey, "A private key is required for propagate"),
        l1Provider,
      );

      const result = await propagate({
        registryAddress: options.registry,
        registryRunner: registrySigner,
        targetProvider: new JsonRpcProvider(options.targetRpc),
        targetAddress: options.address,
        targetChainId: options.chainId,
        expectedCodeHash: options.expectedCodeHash,
      });

      writeJson(result);
    }),
  );

program
  .command("status")
  .requiredOption("--l1-rpc <url>", "Ethereum L1 RPC URL")
  .requiredOption("--registry <address>", "VerificationRegistry address on L1")
  .option("--address <address>", "Target deployed contract address")
  .option("--chain-id <chainId>", "Target chain id for address lookups", parsePositiveInteger)
  .option("--target-rpc <url>", "RPC URL for the target L2")
  .option("--code-hash <hash>", "Lookup by runtime bytecode hash instead of address")
  .option("--ipfs-gateway <url>", "IPFS gateway URL", process.env.IPFS_GATEWAY)
  .action(
    wrapAction(async (options) => {
      const lookupOptions = createLookupOptions(options);
      const result = await lookupVerification(lookupOptions);

      writeJson({
        codeHash: result.codeHash,
        proofCount: result.proofs.length,
        chainCount: result.chainIds.length,
        chains: result.chainIds,
        deploymentsByChain: result.deploymentsByChain,
      });
    }),
  );

program
  .command("propagate-batch")
  .description("Register a deployment across multiple L2 chains in one command")
  .requiredOption("--l1-rpc <url>", "Ethereum L1 RPC URL")
  .requiredOption("--registry <address>", "VerificationRegistry address on L1")
  .requiredOption("--address <address>", "Deployed contract address (same on all chains)")
  .requiredOption("--chains <items>", "Comma-separated list of chainId=rpcUrl pairs (e.g. 10=https://...,42161=https://...)")
  .option("--expected-code-hash <hash>", "Optional expected runtime bytecode hash")
  .option("--private-key <hex>", "Private key for L1 submissions", process.env.PRIVATE_KEY)
  .option("--concurrency <n>", "Max parallel propagations", parsePositiveInteger, 3)
  .action(
    wrapAction(async (options) => {
      const l1Provider = new JsonRpcProvider(options.l1Rpc);
      const registrySigner = new Wallet(
        requiredString(options.privateKey, "A private key is required for propagate-batch"),
        l1Provider,
      );

      const chains = parseChainRpcPairs(options.chains);
      const concurrency = options.concurrency as number;
      const results: Array<{ chainId: number; status: string; error?: string; txHash?: string }> = [];

      const queue = [...chains];
      const run = async () => {
        while (queue.length > 0) {
          const entry = queue.shift()!;
          try {
            const result = await propagate({
              registryAddress: options.registry,
              registryRunner: registrySigner,
              targetProvider: new JsonRpcProvider(entry.rpc),
              targetAddress: options.address,
              targetChainId: entry.chainId,
              expectedCodeHash: options.expectedCodeHash,
            });

            results.push({
              chainId: entry.chainId,
              status: result.transactionHash ? "propagated" : "already-registered",
              txHash: result.transactionHash,
            });
            console.error(`  chain ${entry.chainId}: ${result.transactionHash ? "propagated" : "already registered"}`);
          } catch (error) {
            results.push({
              chainId: entry.chainId,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            });
            console.error(`  chain ${entry.chainId}: error — ${error instanceof Error ? error.message : error}`);
          }
        }
      };

      console.error(`Propagating to ${chains.length} chains (concurrency=${concurrency})...`);
      await Promise.all(Array.from({ length: Math.min(concurrency, chains.length) }, run));

      writeJson({
        address: options.address,
        totalChains: chains.length,
        succeeded: results.filter((r) => r.status !== "error").length,
        failed: results.filter((r) => r.status === "error").length,
        results,
      });
    }),
  );

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function readCompilerInput(path: string): Promise<SolidityStandardJsonInput> {
  return JSON.parse(await readFile(path, "utf8")) as SolidityStandardJsonInput;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function createLookupOptions(options: {
  l1Rpc: string;
  registry: string;
  address?: string;
  chainId?: number;
  targetRpc?: string;
  codeHash?: `0x${string}`;
  ipfsGateway?: string;
}): LookupOptions {
  const registryRunner = new JsonRpcProvider(options.l1Rpc);
  const ipfsClient = new PinataIpfsClient({ gatewayUrl: options.ipfsGateway });

  if (options.codeHash) {
    return {
      kind: "codeHash",
      codeHash: options.codeHash,
      registryAddress: options.registry,
      registryRunner,
      ipfsClient,
    };
  }

  if (!options.address || !options.targetRpc || !options.chainId) {
    throw new Error("Lookup by address requires --address, --target-rpc, and --chain-id");
  }

  return {
    kind: "address",
    targetProvider: new JsonRpcProvider(options.targetRpc),
    targetAddress: options.address,
    targetChainId: options.chainId,
    registryAddress: options.registry,
    registryRunner,
    ipfsClient,
  };
}

async function submitVerificationWithFallback(options: {
  compilerInput: SolidityStandardJsonInput;
  compilerVersion: string;
  contractPath: string;
  contractName: string;
  targetChainId: number;
  targetAddress: string;
  targetRpc: string;
  l1Rpc: string;
  registry: string;
  privateKey?: string;
  pinataJwt?: string;
  pinName?: string;
  ipfsGateway?: string;
}) {
  const l1Provider = new JsonRpcProvider(options.l1Rpc);
  const registrySigner = new Wallet(
    requiredString(options.privateKey, "A private key is required for submission"),
    l1Provider,
  );
  const ipfsClient = new PinataIpfsClient({
    jwt: requiredString(options.pinataJwt, "A Pinata JWT is required for submission"),
    gatewayUrl: options.ipfsGateway,
  });

  return verifyOrPropagate({
    compilerInput: options.compilerInput,
    compilerVersion: options.compilerVersion,
    contractPath: options.contractPath,
    contractName: options.contractName,
    targetChainId: options.targetChainId,
    targetAddress: options.targetAddress,
    targetProvider: new JsonRpcProvider(options.targetRpc),
    registryAddress: options.registry,
    registryRunner: registrySigner,
    ipfsClient,
    pinName: options.pinName,
  });
}

function wrapAction<T>(action: (options: T) => Promise<void>) {
  return async (options: T): Promise<void> => {
    try {
      await action(options);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };
}

function writeJson(value: unknown): void {
  console.log(
    JSON.stringify(
      value,
      (_, entry) => (typeof entry === "bigint" ? entry.toString() : entry),
      2,
    ),
  );
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }

  return parsed;
}

function requiredString(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function parseChainRpcPairs(value: string): Array<{ chainId: number; rpc: string }> {
  return value.split(",").filter(Boolean).map((entry) => {
    const eqIndex = entry.indexOf("=");
    if (eqIndex === -1) {
      throw new Error(`Invalid chain=rpc pair: ${entry}. Expected format: chainId=rpcUrl`);
    }

    return {
      chainId: parsePositiveInteger(entry.slice(0, eqIndex)),
      rpc: entry.slice(eqIndex + 1),
    };
  });
}
