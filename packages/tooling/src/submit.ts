import { JsonRpcProvider, Wallet } from "ethers";

import {
  PinataIpfsClient,
  verifyOrPropagate,
  type SolidityStandardJsonInput,
  type VerifyOrPropagateResult,
} from "@cross-l2-verify/sdk";

export interface SubmissionWithFallbackOptions {
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
}

export async function submitVerificationWithFallback(
  options: SubmissionWithFallbackOptions,
): Promise<VerifyOrPropagateResult> {
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

function requiredString(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }

  return value;
}
