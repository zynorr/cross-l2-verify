import type { SolidityStandardJsonInput } from "./schema.js";

export interface EtherscanSourceResult {
  contractName: string;
  compilerVersion: string;
  compilerInput: SolidityStandardJsonInput;
  contractPath: string;
}

interface EtherscanApiResponse {
  status: string;
  message: string;
  result: EtherscanSourceEntry[];
}

interface EtherscanSourceEntry {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  OptimizationUsed: string;
  Runs: string;
  EVMVersion: string;
  ConstructorArguments: string;
}

const ETHERSCAN_ENDPOINTS: Record<number, string> = {
  1: "https://api.etherscan.io/api",
  11155111: "https://api-sepolia.etherscan.io/api",
  10: "https://api-optimistic.etherscan.io/api",
  11155420: "https://api-sepolia-optimistic.etherscan.io/api",
  8453: "https://api.basescan.org/api",
  84532: "https://api-sepolia.basescan.org/api",
  42161: "https://api.arbiscan.io/api",
  421614: "https://api-sepolia.arbiscan.io/api",
  137: "https://api.polygonscan.com/api",
  324: "https://api.era.zksync.network/api",
};

export function getEtherscanEndpoint(chainId: number): string | undefined {
  return ETHERSCAN_ENDPOINTS[chainId];
}

export async function fetchEtherscanSource(
  address: string,
  chainId: number,
  apiKey?: string,
): Promise<EtherscanSourceResult> {
  const baseUrl = ETHERSCAN_ENDPOINTS[chainId];
  if (!baseUrl) {
    throw new Error(`No Etherscan API endpoint for chain ${chainId}`);
  }

  const params = new URLSearchParams({
    module: "contract",
    action: "getsourcecode",
    address,
  });
  if (apiKey) {
    params.set("apikey", apiKey);
  }

  const response = await fetch(`${baseUrl}?${params}`);
  if (!response.ok) {
    throw new Error(`Etherscan API request failed: ${response.status}`);
  }

  const data = (await response.json()) as EtherscanApiResponse;
  if (data.status !== "1" || !data.result?.length) {
    throw new Error(`Etherscan returned error: ${data.message}`);
  }

  const entry = data.result[0];
  if (!entry.SourceCode) {
    throw new Error("Contract source code not verified on Etherscan");
  }

  return parseEtherscanEntry(entry);
}

function parseEtherscanEntry(entry: EtherscanSourceEntry): EtherscanSourceResult {
  const contractName = entry.ContractName;
  const compilerVersion = normalizeCompilerVersion(entry.CompilerVersion);

  let sourceCode = entry.SourceCode;

  // Etherscan wraps standard JSON input in double braces: {{...}}
  if (sourceCode.startsWith("{{") && sourceCode.endsWith("}}")) {
    sourceCode = sourceCode.slice(1, -1);
  }

  let compilerInput: SolidityStandardJsonInput;
  let contractPath: string;

  if (sourceCode.startsWith("{")) {
    // Standard JSON input
    const parsed = JSON.parse(sourceCode) as SolidityStandardJsonInput & {
      sources?: Record<string, { content: string }>;
    };

    contractPath = findContractPath(parsed.sources ?? {}, contractName);
    compilerInput = {
      language: parsed.language ?? "Solidity",
      sources: parsed.sources ?? {},
      settings: parsed.settings ?? buildSettings(entry),
    };
  } else {
    // Single flat source
    contractPath = `${contractName}.sol`;
    compilerInput = {
      language: "Solidity",
      sources: {
        [contractPath]: { content: sourceCode },
      },
      settings: buildSettings(entry),
    };
  }

  return {
    contractName,
    compilerVersion,
    compilerInput,
    contractPath,
  };
}

function findContractPath(
  sources: Record<string, unknown>,
  contractName: string,
): string {
  // Look for exact match first: "contracts/ContractName.sol"
  for (const path of Object.keys(sources)) {
    const filename = path.split("/").pop() ?? path;
    if (filename === `${contractName}.sol`) {
      return path;
    }
  }

  // Fallback: first source file
  const paths = Object.keys(sources);
  if (paths.length === 0) {
    throw new Error("No source files found");
  }

  return paths[0];
}

function buildSettings(entry: EtherscanSourceEntry): Record<string, unknown> {
  const settings: Record<string, unknown> = {};

  if (entry.OptimizationUsed === "1") {
    settings.optimizer = {
      enabled: true,
      runs: parseInt(entry.Runs, 10) || 200,
    };
  } else {
    settings.optimizer = { enabled: false, runs: 200 };
  }

  if (entry.EVMVersion && entry.EVMVersion !== "Default") {
    settings.evmVersion = entry.EVMVersion.toLowerCase();
  }

  settings.outputSelection = {
    "*": {
      "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
    },
  };

  return settings;
}

function normalizeCompilerVersion(version: string): string {
  // "v0.8.28+commit.7893614a" → "0.8.28"
  return version.replace(/^v/, "").replace(/\+.*$/, "");
}
