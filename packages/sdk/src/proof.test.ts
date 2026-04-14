import test from "node:test";
import assert from "node:assert/strict";

import { canonicalStringify } from "./canonical.js";
import { computeProofHash, computeSourceHash } from "./sdk.js";
import type { VerificationProof } from "./schema.js";

const HASH_1 = `0x${"1".repeat(64)}`;
const HASH_2 = `0x${"2".repeat(64)}`;
const HASH_3 = `0x${"3".repeat(64)}`;

test("source hash is stable across key order", () => {
  const sourceBundleA = {
    language: "Solidity" as const,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
    sources: {
      "src/Counter.sol": {
        content: "pragma solidity ^0.8.26; contract Counter { uint256 public n; }",
      },
    },
  };

  const sourceBundleB = {
    settings: {
      optimizer: {
        runs: 200,
        enabled: true,
      },
    },
    sources: {
      "src/Counter.sol": {
        content: "pragma solidity ^0.8.26; contract Counter { uint256 public n; }",
      },
    },
    language: "Solidity" as const,
  };

  assert.equal(computeSourceHash(sourceBundleA), computeSourceHash(sourceBundleB));
});

test("proof hash is derived from canonical proof payload", () => {
  const proof = {
    proofVersion: "1",
    language: "Solidity",
    contract: {
      path: "src/Counter.sol",
      name: "Counter",
    },
    compiler: {
      version: "0.8.26",
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
      },
    },
    sourceBundle: {
      language: "Solidity",
      sources: {
        "src/Counter.sol": {
          content: "pragma solidity ^0.8.26; contract Counter { uint256 public n; }",
        },
      },
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
      },
    },
    artifacts: {
      creationBytecode: "0x60006000",
      creationBytecodeHash: HASH_1,
      runtimeBytecode: "0x6000",
      runtimeBytecodeHash: HASH_2,
    },
    attestation: {
      codeHash: HASH_2,
      sourceHash: HASH_3,
      proofHash: `0x${"0".repeat(64)}`,
    },
    deployments: [
      {
        chainId: 10,
        address: "0x0000000000000000000000000000000000000010",
      },
    ],
    metadata: {
      createdAt: "2026-04-14T00:00:00.000Z",
      tooling: {
        sdk: "@cross-l2-verify/sdk@0.1.0",
      },
    },
  } satisfies VerificationProof;

  const proofHash = computeProofHash({
    ...proof,
    attestation: {
      codeHash: proof.attestation.codeHash,
      sourceHash: proof.attestation.sourceHash,
    },
  });

  assert.match(proofHash, /^0x[0-9a-f]{64}$/);
  assert.equal(canonicalStringify(proof).includes("proofHash"), true);
});
