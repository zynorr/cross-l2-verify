import { readFile } from "node:fs/promises";

import {
  resolveHardhatHookInput,
  submitVerificationWithFallback,
  type SubmissionWithFallbackOptions,
} from "@cross-l2-verify/tooling";
import { type VerifyOrPropagateResult } from "@cross-l2-verify/sdk";

export interface VerifyHardhatDeploymentOptions
  extends Omit<
    SubmissionWithFallbackOptions,
    "compilerInput" | "compilerVersion" | "contractPath" | "targetChainId" | "targetAddress"
  > {
  buildInfoFile: string;
  contractName: string;
  contractPath?: string;
  deploymentFile?: string;
  buildInfo?: unknown;
  deployment?: unknown;
  address?: string;
  chainId?: number;
}

export async function verifyHardhatDeployment(
  options: VerifyHardhatDeploymentOptions,
): Promise<VerifyOrPropagateResult> {
  const buildInfo = options.buildInfo ?? JSON.parse(await readFile(options.buildInfoFile, "utf8"));
  const deployment =
    options.deploymentFile ? JSON.parse(await readFile(options.deploymentFile, "utf8")) : options.deployment;

  const resolution = resolveHardhatHookInput({
    buildInfo,
    contractName: options.contractName,
    contractPath: options.contractPath,
    deployment,
    address: options.address,
    chainId: options.chainId,
  });

  return submitVerificationWithFallback({
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
}

export function createHardhatVerifyAction(
  defaults: Omit<VerifyHardhatDeploymentOptions, "buildInfoFile" | "contractName">,
) {
  return async function hardhatVerifyAction(
    buildInfoFile: string,
    contractName: string,
    overrides: Partial<Omit<VerifyHardhatDeploymentOptions, "buildInfoFile" | "contractName">> = {},
  ): Promise<VerifyOrPropagateResult> {
    return verifyHardhatDeployment({
      ...defaults,
      ...overrides,
      buildInfoFile,
      contractName,
    });
  };
}
