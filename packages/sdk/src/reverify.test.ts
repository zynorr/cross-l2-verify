import test from "node:test";
import assert from "node:assert/strict";

import { reverifyFromProof } from "./reverify.js";
import { keccak256Hex, keccak256Json, normalizeHex } from "./canonical.js";
import type { VerificationProof } from "./schema.js";
import type { SolcLike } from "./solc.js";

function makeMockCompiler(runtimeBytecode: string, creationBytecode: string): SolcLike {
  return {
    compile(input: string): string {
      const parsed = JSON.parse(input) as { sources: Record<string, unknown> };
      const contractPath = Object.keys(parsed.sources)[0];
      return JSON.stringify({
        contracts: {
          [contractPath]: {
            Counter: {
              evm: {
                bytecode: { object: creationBytecode.replace(/^0x/, "") },
                deployedBytecode: { object: runtimeBytecode.replace(/^0x/, "") },
              },
            },
          },
        },
      });
    },
  };
}

function buildValidProof(runtimeBytecode: string, creationBytecode: string): VerificationProof {
  const runtimeHash = keccak256Hex(runtimeBytecode);
  const creationHash = keccak256Hex(creationBytecode);
  const sourceBundle = {
    language: "Solidity" as const,
    sources: {
      "src/Counter.sol": {
        content: "pragma solidity ^0.8.26; contract Counter { uint256 public n; }",
      },
    },
    settings: {
      optimizer: { enabled: false, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const sourceHash = keccak256Json(sourceBundle);

  const proofWithoutHash = {
    proofVersion: "1" as const,
    language: "Solidity" as const,
    contract: { path: "src/Counter.sol", name: "Counter" },
    compiler: { version: "0.8.26", settings: sourceBundle.settings },
    sourceBundle,
    artifacts: {
      creationBytecode: normalizeHex(creationBytecode),
      creationBytecodeHash: creationHash,
      runtimeBytecode: normalizeHex(runtimeBytecode),
      runtimeBytecodeHash: runtimeHash,
    },
    attestation: { codeHash: runtimeHash, sourceHash },
    deployments: [{ chainId: 10, address: "0x0000000000000000000000000000000000000010" }],
    metadata: { createdAt: "2026-04-14T00:00:00.000Z", tooling: { sdk: "@cross-l2-verify/sdk@0.1.0" } },
  };

  const proofHash = keccak256Json(proofWithoutHash);
  return { ...proofWithoutHash, attestation: { ...proofWithoutHash.attestation, proofHash } };
}

test("reverify passes for a valid proof", async () => {
  const runtime = "0x6080604052";
  const creation = "0x6080604052600080";
  const proof = buildValidProof(runtime, creation);
  const compiler = makeMockCompiler(runtime, creation);

  const result = await reverifyFromProof({ proof, compiler });

  assert.equal(result.valid, true);
  assert.equal(result.checks.length, 5);
  assert.ok(result.checks.every((c) => c.passed));
});

test("reverify detects runtime bytecode mismatch", async () => {
  const runtime = "0x6080604052";
  const creation = "0x6080604052600080";
  const proof = buildValidProof(runtime, creation);

  // Compiler returns different runtime bytecode
  const compiler = makeMockCompiler("0xdeadbeef", creation);

  const result = await reverifyFromProof({ proof, compiler });

  assert.equal(result.valid, false);
  const failedChecks = result.checks.filter((c) => !c.passed);
  assert.ok(failedChecks.some((c) => c.name === "runtime-bytecode-hash"));
  assert.ok(failedChecks.some((c) => c.name === "code-hash-matches-runtime"));
});

test("reverify detects creation bytecode mismatch", async () => {
  const runtime = "0x6080604052";
  const creation = "0x6080604052600080";
  const proof = buildValidProof(runtime, creation);

  // Compiler returns different creation bytecode
  const compiler = makeMockCompiler(runtime, "0xdeadbeef");

  const result = await reverifyFromProof({ proof, compiler });

  assert.equal(result.valid, false);
  const failedChecks = result.checks.filter((c) => !c.passed);
  assert.equal(failedChecks.length, 1);
  assert.equal(failedChecks[0].name, "creation-bytecode-hash");
});
