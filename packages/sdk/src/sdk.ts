import {
  Contract,
  type AbstractProvider,
  type ContractRunner,
  getAddress,
} from "ethers";

import { VERIFICATION_REGISTRY_ABI } from "./abi/VerificationRegistry.js";
import { keccak256Hex, keccak256Json, normalizeHex } from "./canonical.js";
import type { IpfsPinClient } from "./ipfs.js";
import { VerificationProofSchema, type SolidityStandardJsonInput, type VerificationProof } from "./schema.js";
import { compileSolidity, getCompiledContract } from "./solc.js";

export interface VerifyOptions {
  compilerInput: SolidityStandardJsonInput;
  compilerVersion: string;
  contractPath: string;
  contractName: string;
  targetChainId: number;
  targetAddress: string;
  targetProvider: AbstractProvider;
  registryAddress: string;
  registryRunner: ContractRunner;
  ipfsClient: IpfsPinClient;
  pinName?: string;
}

export interface VerifyResult {
  codeHash: `0x${string}`;
  sourceHash: `0x${string}`;
  proofHash: `0x${string}`;
  cid: string;
  transactionHash?: string;
  proof: VerificationProof;
}

export interface LookupByAddressOptions {
  kind: "address";
  targetProvider: AbstractProvider;
  targetAddress: string;
  targetChainId: number;
  registryAddress: string;
  registryRunner: ContractRunner;
  ipfsClient: IpfsPinClient;
}

export interface LookupByCodeHashOptions {
  kind: "codeHash";
  codeHash: `0x${string}`;
  registryAddress: string;
  registryRunner: ContractRunner;
  ipfsClient: IpfsPinClient;
}

export type LookupOptions = LookupByAddressOptions | LookupByCodeHashOptions;

export interface LookupResult {
  codeHash: `0x${string}`;
  chainIds: number[];
  deploymentsByChain: Record<string, string[]>;
  proofs: AnchoredProof[];
}

export interface PropagateOptions {
  registryAddress: string;
  registryRunner: ContractRunner;
  targetProvider: AbstractProvider;
  targetAddress: string;
  targetChainId: number;
  expectedCodeHash?: `0x${string}`;
}

export interface PropagateResult {
  codeHash: `0x${string}`;
  targetAddress: string;
  targetChainId: number;
  transactionHash?: string;
}

export interface AnchoredProof {
  proofHash: `0x${string}`;
  cid: string;
  compilerVersion: string;
  submitter: string;
  submittedAt: bigint;
  proof: VerificationProof;
}

export interface GetProofByHashOptions {
  proofHash: `0x${string}`;
  registryAddress: string;
  registryRunner: ContractRunner;
  ipfsClient: IpfsPinClient;
}

export function computeSourceHash(sourceBundle: SolidityStandardJsonInput): `0x${string}` {
  return keccak256Json(sourceBundle);
}

export function computeCodeHash(runtimeBytecode: string): `0x${string}` {
  return keccak256Hex(runtimeBytecode);
}

export function computeProofHash(proof: Omit<VerificationProof, "attestation"> & {
  attestation: Omit<VerificationProof["attestation"], "proofHash">;
}): `0x${string}` {
  return keccak256Json(proof);
}

export async function verify(options: VerifyOptions): Promise<VerifyResult> {
  const compilerOutput = await compileSolidity(options.compilerInput);
  const contractOutput = getCompiledContract(
    compilerOutput,
    options.contractPath,
    options.contractName,
  );

  const compiledCreationBytecode = normalizeBytecode(contractOutput.evm?.bytecode?.object);
  const compiledRuntimeBytecode = normalizeBytecode(contractOutput.evm?.deployedBytecode?.object);
  const deployedRuntimeBytecode = normalizeBytecode(
    await options.targetProvider.getCode(getAddress(options.targetAddress)),
  );

  if (compiledRuntimeBytecode !== deployedRuntimeBytecode) {
    throw new Error("Compiled runtime bytecode does not match the deployed runtime bytecode");
  }

  const sourceBundle = options.compilerInput;
  const codeHash = computeCodeHash(compiledRuntimeBytecode);
  const sourceHash = computeSourceHash(sourceBundle);
  const createdAt = new Date().toISOString();

  const unsignedProof = {
    proofVersion: "1" as const,
    language: "Solidity" as const,
    contract: {
      path: options.contractPath,
      name: options.contractName,
    },
    compiler: {
      version: options.compilerVersion,
      settings: options.compilerInput.settings,
    },
    sourceBundle,
    artifacts: {
      creationBytecode: compiledCreationBytecode,
      creationBytecodeHash: computeCodeHash(compiledCreationBytecode),
      runtimeBytecode: compiledRuntimeBytecode,
      runtimeBytecodeHash: codeHash,
    },
    attestation: {
      codeHash,
      sourceHash,
    },
    deployments: [
      {
        chainId: options.targetChainId,
        address: getAddress(options.targetAddress),
      },
    ],
    metadata: {
      createdAt,
      tooling: {
        sdk: "@cross-l2-verify/sdk@0.1.0",
      },
    },
  };

  const proofHash = computeProofHash(unsignedProof);
  const proof = VerificationProofSchema.parse({
    ...unsignedProof,
    attestation: {
      ...unsignedProof.attestation,
      proofHash,
    },
  });

  const { cid } = await options.ipfsClient.pinJson(proof, {
    name: options.pinName ?? `${options.contractName}-${proofHash}`,
  });

  const registry = new Contract(
    getAddress(options.registryAddress),
    VERIFICATION_REGISTRY_ABI,
    options.registryRunner,
  );

  const tx = await registry.submitProofAndRegister(
    proofHash,
    codeHash,
    sourceHash,
    options.compilerVersion,
    cid,
    BigInt(options.targetChainId),
    getAddress(options.targetAddress),
  );
  const receipt = await tx.wait();

  return {
    codeHash,
    sourceHash,
    proofHash,
    cid,
    transactionHash: receipt?.hash,
    proof,
  };
}

export async function lookup(options: LookupOptions): Promise<LookupResult> {
  const registry = new Contract(
    getAddress(options.registryAddress),
    VERIFICATION_REGISTRY_ABI,
    options.registryRunner,
  );

  const codeHash =
    options.kind === "address"
      ? computeCodeHash(await resolveRuntimeBytecode(options.targetProvider, options.targetAddress))
      : normalizeHex(options.codeHash);

  const proofHashes = (await registry.getProofHashes(codeHash)) as `0x${string}`[];
  const chainIds = ((await registry.getRegisteredChainIds(codeHash)) as bigint[]).map((chainId) =>
    Number(chainId),
  );

  const deploymentsByChain = Object.fromEntries(
    await Promise.all(
      chainIds.map(async (chainId) => {
        const deployments = (await registry.getDeployments(codeHash, BigInt(chainId))) as string[];
        return [String(chainId), deployments.map((deployment) => getAddress(deployment))];
      }),
    ),
  ) as Record<string, string[]>;

  const proofs = await Promise.all(
    proofHashes.map((proofHash) =>
      getProofByHash({
        proofHash,
        registryAddress: options.registryAddress,
        registryRunner: options.registryRunner,
        ipfsClient: options.ipfsClient,
      }),
    ),
  );

  return {
    codeHash,
    chainIds,
    deploymentsByChain,
    proofs,
  };
}

export async function propagate(options: PropagateOptions): Promise<PropagateResult> {
  const registry = new Contract(
    getAddress(options.registryAddress),
    VERIFICATION_REGISTRY_ABI,
    options.registryRunner,
  );

  const targetAddress = getAddress(options.targetAddress);
  const codeHash = computeCodeHash(await resolveRuntimeBytecode(options.targetProvider, targetAddress));
  if (options.expectedCodeHash && normalizeHex(options.expectedCodeHash) !== codeHash) {
    throw new Error("Target deployment bytecode does not match the expected code hash");
  }

  const proofHashes = (await registry.getProofHashes(codeHash)) as `0x${string}`[];
  if (proofHashes.length === 0) {
    throw new Error(`No anchored proofs found for code hash ${codeHash}`);
  }

  const tx = await registry.registerDeployment(codeHash, BigInt(options.targetChainId), targetAddress);
  const receipt = await tx.wait();

  return {
    codeHash,
    targetAddress,
    targetChainId: options.targetChainId,
    transactionHash: receipt?.hash,
  };
}

export async function getProofByHash(options: GetProofByHashOptions): Promise<AnchoredProof> {
  const registry = new Contract(
    getAddress(options.registryAddress),
    VERIFICATION_REGISTRY_ABI,
    options.registryRunner,
  );

  const record = (await registry.getRecord(options.proofHash)) as {
    codeHash: string;
    sourceHash: string;
    compilerVersion: string;
    ipfsCid: string;
    submitter: string;
    submittedAt: bigint;
  };

  const proof = VerificationProofSchema.parse(await options.ipfsClient.fetchJson(record.ipfsCid));
  validateProofAgainstRecord(options.proofHash, proof, record);

  return {
    proofHash: normalizeHex(options.proofHash),
    cid: record.ipfsCid,
    compilerVersion: record.compilerVersion,
    submitter: getAddress(record.submitter),
    submittedAt: record.submittedAt,
    proof,
  };
}

async function resolveRuntimeBytecode(
  provider: AbstractProvider,
  address: string,
): Promise<`0x${string}`> {
  const bytecode = normalizeHex(await provider.getCode(getAddress(address)));
  if (bytecode === "0x") {
    throw new Error(`No runtime bytecode found at ${address}`);
  }

  return bytecode;
}

function normalizeBytecode(bytecode?: string): `0x${string}` {
  if (!bytecode || bytecode === "0x") {
    throw new Error("Missing bytecode in compiler output");
  }

  return normalizeHex(bytecode);
}

function validateProofAgainstRecord(
  expectedProofHash: `0x${string}`,
  proof: VerificationProof,
  record: {
    codeHash: string;
    sourceHash: string;
    compilerVersion: string;
    ipfsCid: string;
  },
): void {
  const recomputedSourceHash = computeSourceHash(proof.sourceBundle);
  const recomputedProofHash = computeProofHash({
    ...proof,
    attestation: {
      codeHash: proof.attestation.codeHash,
      sourceHash: proof.attestation.sourceHash,
    },
  });

  if (normalizeHex(record.codeHash) !== normalizeHex(proof.attestation.codeHash)) {
    throw new Error("Onchain code hash does not match proof payload");
  }

  if (normalizeHex(record.sourceHash) !== recomputedSourceHash) {
    throw new Error("Onchain source hash does not match recomputed source hash");
  }

  if (normalizeHex(proof.attestation.sourceHash) !== recomputedSourceHash) {
    throw new Error("Proof source hash does not match recomputed source hash");
  }

  if (normalizeHex(proof.attestation.proofHash) !== recomputedProofHash) {
    throw new Error("Proof hash field does not match canonical proof hash");
  }

  if (normalizeHex(expectedProofHash) !== recomputedProofHash) {
    throw new Error("Requested proof hash does not match fetched proof payload");
  }

  if (proof.compiler.version !== record.compilerVersion) {
    throw new Error("Onchain compiler version does not match proof payload");
  }
}
