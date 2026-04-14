import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  resolveFoundryHookInput,
  submitVerificationWithFallback,
  type SubmissionWithFallbackOptions,
} from "@cross-l2-verify/tooling";
import { type SolidityStandardJsonInput, type VerifyOrPropagateResult } from "@cross-l2-verify/sdk";

export interface VerifyFoundryDeploymentOptions
  extends Omit<
    SubmissionWithFallbackOptions,
    "compilerInput" | "compilerVersion" | "contractPath" | "targetChainId" | "targetAddress"
  > {
  broadcastFile: string;
  compilerInputFile: string;
  compilerVersion: string;
  contractName: string;
  contractPath: string;
  broadcast?: unknown;
  compilerInput?: SolidityStandardJsonInput;
  address?: string;
  chainId?: number;
}

export async function verifyFoundryDeployment(
  options: VerifyFoundryDeploymentOptions,
): Promise<VerifyOrPropagateResult> {
  const [broadcast, compilerInput] = await Promise.all([
    options.broadcast ?? readJsonFile(options.broadcastFile),
    options.compilerInput ?? (readJsonFile(options.compilerInputFile) as Promise<SolidityStandardJsonInput>),
  ]);

  const deployment = resolveFoundryHookInput({
    broadcast,
    contractName: options.contractName,
    address: options.address,
    chainId: options.chainId,
  });

  return submitVerificationWithFallback({
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
}

export function createFoundryVerifyAction(
  defaults: Omit<VerifyFoundryDeploymentOptions, "broadcastFile" | "compilerInputFile" | "contractName" | "contractPath">,
) {
  return async function foundryVerifyAction(
    broadcastFile: string,
    compilerInputFile: string,
    contractName: string,
    contractPath: string,
    overrides: Partial<Omit<VerifyFoundryDeploymentOptions, "broadcastFile" | "compilerInputFile" | "contractName">> = {},
  ): Promise<VerifyOrPropagateResult> {
    return verifyFoundryDeployment({
      ...defaults,
      ...overrides,
      broadcastFile,
      compilerInputFile,
      contractName,
      contractPath,
    });
  };
}

export interface FoundryBroadcastScanOptions {
  broadcastDir: string;
  chainId: number;
  scriptName?: string;
}

export async function findLatestBroadcast(options: FoundryBroadcastScanOptions): Promise<string> {
  const scriptName = options.scriptName ?? "Deploy.s.sol";
  const path = resolve(options.broadcastDir, scriptName, String(options.chainId), "run-latest.json");

  try {
    await readFile(path, "utf8");
    return path;
  } catch {
    throw new Error(
      `Broadcast file not found at ${path}. Run your Foundry script with --broadcast first.`,
    );
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
