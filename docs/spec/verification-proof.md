# Verification Proof Format

## Goal

The verification proof is the portable, chain-agnostic artifact that binds a Solidity source bundle and compiler configuration to a concrete runtime bytecode image.

The proof is designed to be:

- reproducible offchain,
- anchored on Ethereum L1,
- reusable across any EVM chain where the same runtime bytecode exists.

## Canonical Keys

- `codeHash`: `keccak256(runtimeBytecode)`
- `sourceHash`: `keccak256(canonical source bundle)`
- `proofHash`: `keccak256(canonical proof payload without attestation.proofHash)`

`codeHash` is the primary registry key. A single proof may cover multiple deployments on multiple chains if they resolve to the same runtime bytecode.

## Version 1 Proof Object

```json
{
  "proofVersion": "1",
  "language": "Solidity",
  "contract": {
    "path": "src/Counter.sol",
    "name": "Counter"
  },
  "compiler": {
    "version": "0.8.26",
    "settings": {
      "optimizer": {
        "enabled": true,
        "runs": 200
      },
      "evmVersion": "cancun",
      "viaIR": false,
      "metadata": {
        "bytecodeHash": "ipfs"
      }
    }
  },
  "sourceBundle": {
    "language": "Solidity",
    "sources": {
      "src/Counter.sol": {
        "content": "pragma solidity ^0.8.26; ..."
      }
    },
    "settings": {
      "optimizer": {
        "enabled": true,
        "runs": 200
      }
    }
  },
  "artifacts": {
    "creationBytecodeHash": "0x...",
    "runtimeBytecodeHash": "0x..."
  },
  "attestation": {
    "codeHash": "0x...",
    "sourceHash": "0x...",
    "proofHash": "0x..."
  },
  "deployments": [
    {
      "chainId": 42161,
      "address": "0x..."
    }
  ],
  "metadata": {
    "createdAt": "2026-04-14T00:00:00.000Z",
    "tooling": {
      "sdk": "@cross-l2-verify/sdk@0.1.0"
    }
  }
}
```

## Canonical Serialization

`proofHash` and `sourceHash` MUST be computed from canonical JSON serialization:

- UTF-8 encoded JSON
- object keys sorted lexicographically
- arrays preserved in-order
- no insignificant whitespace
- hex strings lowercased with `0x` prefix

The SDK implements canonical serialization so every client derives the same hashes. To avoid circular hashing, `proofHash` is computed from the proof payload with `attestation.proofHash` omitted, then inserted into the final proof object.

## Required Fields

- `proofVersion`
- `language`
- `contract.path`
- `contract.name`
- `compiler.version`
- `compiler.settings`
- `sourceBundle`
- `sources`
- `artifacts.creationBytecodeHash`
- `artifacts.runtimeBytecodeHash`
- `attestation.codeHash`
- `attestation.sourceHash`
- `attestation.proofHash`

## Source Bundle Hashing

`sourceHash` is computed over a canonical source bundle object:

```json
{
  "language": "Solidity",
  "sources": {
    "src/Counter.sol": {
      "content": "pragma solidity ^0.8.26; ..."
    }
  },
  "settings": {
    "optimizer": {
      "enabled": true,
      "runs": 200
    }
  }
}
```

For v1, the source bundle is restricted to Solidity standard JSON inputs and exact runtime bytecode matches.

## Attestation Model

The L1 contract does not prove source correctness onchain. Instead, it anchors immutable attestations that can be independently replayed by any resolver:

1. Recompile source with the declared compiler settings.
2. Compare the compiled runtime bytecode with the deployed runtime bytecode.
3. Recompute `codeHash`, `sourceHash`, and `proofHash`.
4. Confirm the anchored onchain record matches the IPFS-hosted proof.

This keeps the registry permissionless while avoiding false claims of onchain verification.

## IPFS Payload

The full proof object is stored on IPFS. The L1 contract stores only:

- `proofHash`
- `codeHash`
- `sourceHash`
- `compilerVersion`
- `ipfsCid`
- `submitter`
- `submittedAt`

## Out Of Scope For V1

- proxy implementation tracing
- semantic equivalence across compiler versions
- Vyper, Huff, Yul, or Stylus sources
- metadata reconstruction for partially available sources
- onchain bytecode decompression or verification circuits
