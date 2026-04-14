import solc from "solc";

import { SolidityStandardJsonInputSchema, type SolidityStandardJsonInput } from "./schema.js";

export interface SolidityCompilerError {
  severity: "error" | "warning";
  message: string;
  formattedMessage?: string;
}

export interface SolidityCompiledContract {
  abi?: unknown[];
  evm?: {
    bytecode?: {
      object?: string;
    };
    deployedBytecode?: {
      object?: string;
    };
  };
}

export interface SolidityCompilerOutput {
  contracts?: Record<string, Record<string, SolidityCompiledContract>>;
  errors?: SolidityCompilerError[];
}

export interface SolcLike {
  compile(input: string): string;
}

export async function compileSolidity(
  compilerInput: SolidityStandardJsonInput,
  compiler: SolcLike = solc as SolcLike,
): Promise<SolidityCompilerOutput> {
  const input = SolidityStandardJsonInputSchema.parse(compilerInput);
  const output = JSON.parse(compiler.compile(JSON.stringify(input))) as SolidityCompilerOutput;

  const errors = output.errors ?? [];
  const fatalErrors = errors.filter((error) => error.severity === "error");
  if (fatalErrors.length > 0) {
    throw new Error(
      [
        "solc compilation failed:",
        ...fatalErrors.map((error) => error.formattedMessage ?? error.message),
      ].join("\n"),
    );
  }

  return output;
}

export function getCompiledContract(
  compilerOutput: SolidityCompilerOutput,
  contractPath: string,
  contractName: string,
): SolidityCompiledContract {
  const fileContracts = compilerOutput.contracts?.[contractPath];
  if (!fileContracts) {
    throw new Error(`Missing compiler output for ${contractPath}`);
  }

  const contractOutput = fileContracts[contractName];
  if (!contractOutput) {
    throw new Error(`Missing contract ${contractName} in ${contractPath}`);
  }

  return contractOutput;
}

