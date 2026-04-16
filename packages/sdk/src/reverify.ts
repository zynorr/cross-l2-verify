import type { IpfsPinClient } from "./ipfs.js";
import { VerificationProofSchema, type VerificationProof } from "./schema.js";
import { compileSolidity, getCompiledContract, type SolcLike } from "./solc.js";
import { keccak256Hex, keccak256Json, normalizeHex } from "./canonical.js";

export interface ReverifyFromCidOptions {
  cid: string;
  ipfsClient: IpfsPinClient;
  compiler?: SolcLike;
}

export interface ReverifyFromProofOptions {
  proof: VerificationProof;
  compiler?: SolcLike;
}

export interface ReverifyCheck {
  name: string;
  passed: boolean;
  expected: string;
  actual: string;
}

export interface ReverifyResult {
  valid: boolean;
  proof: VerificationProof;
  checks: ReverifyCheck[];
  recompiledRuntimeBytecodeHash: `0x${string}`;
  recompiledCreationBytecodeHash: `0x${string}`;
}

function addCheck(
  checks: ReverifyCheck[],
  name: string,
  expected: string,
  actual: string,
): void {
  checks.push({ name, passed: normalizeHex(expected) === normalizeHex(actual), expected, actual });
}

async function reverifyProof(
  proof: VerificationProof,
  compiler?: SolcLike,
): Promise<ReverifyResult> {
  const checks: ReverifyCheck[] = [];

  // 1. Recompile from source bundle
  const compilerOutput = await compileSolidity(proof.sourceBundle, compiler);
  const contractOutput = getCompiledContract(
    compilerOutput,
    proof.contract.path,
    proof.contract.name,
  );

  const recompiledRuntime = normalizeHex(contractOutput.evm?.deployedBytecode?.object ?? "0x");
  const recompiledCreation = normalizeHex(contractOutput.evm?.bytecode?.object ?? "0x");
  const recompiledRuntimeHash = keccak256Hex(recompiledRuntime);
  const recompiledCreationHash = keccak256Hex(recompiledCreation);

  // 2. Check runtime bytecode matches
  addCheck(
    checks,
    "runtime-bytecode-hash",
    proof.artifacts.runtimeBytecodeHash,
    recompiledRuntimeHash,
  );

  // 3. Check creation bytecode matches
  addCheck(
    checks,
    "creation-bytecode-hash",
    proof.artifacts.creationBytecodeHash,
    recompiledCreationHash,
  );

  // 4. Check code hash matches runtime bytecode hash
  addCheck(
    checks,
    "code-hash-matches-runtime",
    proof.attestation.codeHash,
    recompiledRuntimeHash,
  );

  // 5. Check source hash is correct
  const recomputedSourceHash = keccak256Json(proof.sourceBundle);
  addCheck(
    checks,
    "source-hash",
    proof.attestation.sourceHash,
    recomputedSourceHash,
  );

  // 6. Check proof hash is correct (computed over proof without proofHash field)
  const { proofHash: _removed, ...attestationWithoutProofHash } = proof.attestation;
  const proofWithoutHash = { ...proof, attestation: attestationWithoutProofHash };
  const recomputedProofHash = keccak256Json(proofWithoutHash);
  addCheck(
    checks,
    "proof-hash",
    proof.attestation.proofHash,
    recomputedProofHash,
  );

  return {
    valid: checks.every((c) => c.passed),
    proof,
    checks,
    recompiledRuntimeBytecodeHash: recompiledRuntimeHash,
    recompiledCreationBytecodeHash: recompiledCreationHash,
  };
}

export async function reverifyFromCid(options: ReverifyFromCidOptions): Promise<ReverifyResult> {
  const raw = await options.ipfsClient.fetchJson<unknown>(options.cid);
  const proof = VerificationProofSchema.parse(raw);
  return reverifyProof(proof, options.compiler);
}

export async function reverifyFromProof(options: ReverifyFromProofOptions): Promise<ReverifyResult> {
  return reverifyProof(options.proof, options.compiler);
}
