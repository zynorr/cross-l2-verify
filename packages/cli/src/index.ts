#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { Command } from "commander";
import { JsonRpcProvider, Wallet } from "ethers";

import {
  PinataIpfsClient,
  lookup as lookupVerification,
  propagate,
  verify,
  type LookupOptions,
  type SolidityStandardJsonInput,
} from "@cross-l2-verify/sdk";

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

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function readCompilerInput(path: string): Promise<SolidityStandardJsonInput> {
  return JSON.parse(await readFile(path, "utf8")) as SolidityStandardJsonInput;
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

