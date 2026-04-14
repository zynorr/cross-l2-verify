import { getAddress } from "ethers";

import {
  SolidityStandardJsonInputSchema,
  type SolidityStandardJsonInput,
} from "@cross-l2-verify/sdk";

export interface FoundryHookResolution {
  address: string;
  chainId: number;
}

export interface HardhatHookResolution {
  address: string;
  chainId: number;
  compilerInput: SolidityStandardJsonInput;
  compilerVersion: string;
  contractPath: string;
}

export function resolveFoundryHookInput(options: {
  broadcast: unknown;
  contractName: string;
  address?: string;
  chainId?: number;
}): FoundryHookResolution {
  const broadcast = asRecord(options.broadcast, "Foundry broadcast JSON");
  const transactions = Array.isArray(broadcast.transactions) ? broadcast.transactions : [];

  const candidate = [...transactions]
    .reverse()
    .map((transaction) => asRecord(transaction, "Foundry transaction"))
    .find((transaction) => {
      const transactionType = maybeString(transaction.transactionType);
      const contractAddress = maybeString(transaction.contractAddress);
      const contractName = maybeString(transaction.contractName);

      return (
        !!contractAddress &&
        (transactionType === "CREATE" || transactionType === "CREATE2") &&
        (!contractName || contractName === options.contractName)
      );
    });

  const address =
    options.address ??
    maybeNormalizedAddress(candidate?.contractAddress) ??
    fail(`Could not infer a deployment address for ${options.contractName} from the Foundry broadcast file`);

  const chainId =
    options.chainId ??
    maybePositiveInteger(candidate?.chainId) ??
    maybePositiveInteger(broadcast.chain) ??
    maybePositiveInteger(broadcast.chainId) ??
    fail("Could not infer a chain id from the Foundry broadcast file; pass --chain-id");

  return {
    address,
    chainId,
  };
}

export function resolveHardhatHookInput(options: {
  buildInfo: unknown;
  contractName: string;
  contractPath?: string;
  deployment?: unknown;
  address?: string;
  chainId?: number;
}): HardhatHookResolution {
  const buildInfo = asRecord(options.buildInfo, "Hardhat build-info JSON");
  const compilerInput = SolidityStandardJsonInputSchema.parse(buildInfo.input);
  const compilerVersion =
    maybeString(buildInfo.solcLongVersion) ??
    maybeString(buildInfo.solcVersion) ??
    fail("Hardhat build-info JSON is missing solcLongVersion/solcVersion");

  const output = asRecord(buildInfo.output, "Hardhat build-info output");
  const contracts = asRecord(output.contracts, "Hardhat build-info contracts");
  const contractPath = options.contractPath ?? resolveUniqueContractPath(contracts, options.contractName);

  const contractEntries = contracts[contractPath];
  const contractOutput = asRecord(contractEntries, `Hardhat contract group for ${contractPath}`);
  if (!(options.contractName in contractOutput)) {
    throw new Error(`Contract ${options.contractName} was not found under ${contractPath} in Hardhat build-info`);
  }

  const deploymentRecord = options.deployment ? asRecord(options.deployment, "Hardhat deployment JSON") : undefined;
  const address =
    options.address ??
    maybeNormalizedAddress(deploymentRecord?.address) ??
    maybeNormalizedAddress(deploymentRecord?.contractAddress) ??
    maybeNormalizedAddress(maybeRecord(deploymentRecord?.receipt)?.contractAddress) ??
    fail("Could not infer a deployment address; pass --address or --deployment-file");

  const chainId =
    options.chainId ??
    maybePositiveInteger(deploymentRecord?.chainId) ??
    maybePositiveInteger(maybeRecord(deploymentRecord?.receipt)?.chainId) ??
    maybePositiveInteger(maybeRecord(deploymentRecord?.network)?.chainId) ??
    fail("Could not infer a chain id; pass --chain-id or include it in the deployment file");

  return {
    address,
    chainId,
    compilerInput,
    compilerVersion,
    contractPath,
  };
}

function resolveUniqueContractPath(
  contracts: Record<string, unknown>,
  contractName: string,
): string {
  const matches = Object.entries(contracts)
    .filter(([, group]) => {
      const contractGroup = maybeRecord(group);
      return !!contractGroup && contractName in contractGroup;
    })
    .map(([contractPath]) => contractPath);

  if (matches.length === 0) {
    throw new Error(`Could not find ${contractName} in the Hardhat build-info output`);
  }

  if (matches.length > 1) {
    throw new Error(
      `Multiple contract paths matched ${contractName}; pass --contract-path explicitly (${matches.join(", ")})`,
    );
  }

  return matches[0];
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function maybePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "bigint" && value > 0n) {
    return Number(value);
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function maybeNormalizedAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }

  return getAddress(value);
}

function fail(message: string): never {
  throw new Error(message);
}
