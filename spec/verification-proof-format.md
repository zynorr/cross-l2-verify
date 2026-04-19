# Verification Proof Format — v1

**Status:** Draft
**Authors:** cross-l2-verify
**Schema Version:** `1`

---

## Abstract

This document specifies the JSON structure of a **Verification Proof** — the canonical artifact that links a contract's source code to its runtime bytecode and anchors that link on Ethereum L1. A single proof covers every EVM chain where the same runtime bytecode is deployed.

---

## Motivation

Block explorers (Etherscan, Blockscout, Sourcify) maintain per-chain verification silos. A contract verified on Arbitrum must be re-verified on Base, Optimism, zkSync, and every other L2 independently. This creates duplicated effort, divergent trust roots, and no machine-readable cross-chain reference.

The Verification Proof Format solves this by:

1. Keying verification on `keccak256(runtimeBytecode)` — deterministic regardless of chain or deployer
2. Storing the full compiler input on IPFS — permissionless retrieval, content-addressed integrity
3. Anchoring two hashes on Ethereum L1 — `codeHash` and `sourceHash` — with a pointer to the IPFS document
4. Enabling **propagation**: once a proof exists, any deployment of the same bytecode on any chain can be registered without resubmitting source

---

## Definitions

| Term | Definition |
|---|---|
| `codeHash` | `keccak256(runtimeBytecode)` — the primary key for all lookups |
| `sourceHash` | `keccak256(abi.encode(compilerInput))` — commits the exact compiler input |
| `proofHash` | `keccak256(abi.encode(codeHash, sourceHash))` — unique per (bytecode, source) pair |
| `runtimeBytecode` | The deployed bytecode returned by `eth_getCode`, without constructor or metadata |
| `creationBytecode` | The initcode passed to the deployment transaction |
| Compiler Input | A Solidity Standard JSON Input object as specified by the Solidity compiler |

---

## Schema

### Top-level

```json
{
  "proofVersion": "1",
  "language": "Solidity",
  "contract": { ... },
  "compiler": { ... },
  "sourceBundle": { ... },
  "artifacts": { ... },
  "attestation": { ... },
  "deployments": [ ... ],
  "metadata": { ... }
}
```

### `contract`

Identifies the specific contract within the source bundle.

```json
{
  "contract": {
    "path": "src/Counter.sol",
    "name": "Counter"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `path` | `string` | File path key within `sourceBundle.sources` |
| `name` | `string` | Contract name as it appears in the Solidity source |

### `compiler`

```json
{
  "compiler": {
    "version": "0.8.26+commit.8a97fa7a",
    "settings": {
      "optimizer": { "enabled": true, "runs": 200 },
      "evmVersion": "paris",
      "viaIR": false,
      "outputSelection": { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } }
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `version` | `string` | Full semver + commit, e.g. `0.8.26+commit.8a97fa7a` |
| `settings` | `object` | Compiler settings object as passed to `solc` standard JSON |

The `settings` object **must** contain enough information to reproduce the exact compilation output deterministically.

### `sourceBundle`

A complete Solidity Standard JSON Input, as specified by the [Solidity compiler docs](https://docs.soliditylang.org/en/latest/using-the-compiler.html#input-description). All source files must be inlined (no URL references).

```json
{
  "sourceBundle": {
    "language": "Solidity",
    "sources": {
      "src/Counter.sol": {
        "content": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.26;\n..."
      }
    },
    "settings": {
      "optimizer": { "enabled": true, "runs": 200 },
      "outputSelection": { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } }
    }
  }
}
```

### `artifacts`

Bytecodes captured from the compilation output.

```json
{
  "artifacts": {
    "creationBytecode": "0x608060...",
    "creationBytecodeHash": "0xabc123...",
    "runtimeBytecode": "0x608060...",
    "runtimeBytecodeHash": "0xdef456..."
  }
}
```

| Field | Type | Description |
|---|---|---|
| `creationBytecode` | `hex` | `evm.bytecode.object` from compiler output (initcode, no constructor args) |
| `creationBytecodeHash` | `hex` | `keccak256(creationBytecode)` |
| `runtimeBytecode` | `hex` | `evm.deployedBytecode.object` from compiler output |
| `runtimeBytecodeHash` | `hex` | `keccak256(runtimeBytecode)` — **this is `codeHash`** |

### `attestation`

The three hashes that form the on-chain anchor. These values are what gets stored in the `VerificationRegistry` contract on Ethereum L1.

```json
{
  "attestation": {
    "codeHash": "0xd03e50f96b3f28d8c1d79e364f9073e9a3df852b4fd3940e2651a240fd29e7cd",
    "sourceHash": "0xd27df30bc2d2473f5eff1a64db2931e1a10a1174d71171c125a69a0e250a3e39",
    "proofHash": "0x185fa9389388ce37d6ec27ed51609e943cc4b653249e720eeae1f0c9859fea89"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `codeHash` | `bytes32` | `keccak256(runtimeBytecode)` — primary lookup key |
| `sourceHash` | `bytes32` | `keccak256(abi.encodePacked(sourceBundle JSON string))` |
| `proofHash` | `bytes32` | `keccak256(abi.encodePacked(codeHash, sourceHash))` — unique per proof |

Hash computation pseudocode:

```
codeHash   = keccak256(hex_decode(runtimeBytecode))
sourceHash = keccak256(utf8_encode(JSON.stringify(sourceBundle)))
proofHash  = keccak256(concat(codeHash, sourceHash))
```

### `deployments`

Known deployments at proof creation time. This list is advisory — the authoritative source of deployments is the `VerificationRegistry` contract.

```json
{
  "deployments": [
    { "chainId": 421614, "address": "0xBf54c6cD835aFDaFDeBd3e9a31F6E5c860C99AE8" },
    { "chainId": 84532,  "address": "0xBf54c6cD835aFDaFDeBd3e9a31F6E5c860C99AE8" }
  ]
}
```

### `metadata`

```json
{
  "metadata": {
    "createdAt": "2026-04-20T00:00:00.000Z",
    "tooling": {
      "sdk": "0.1.0"
    }
  }
}
```

---

## Complete Example

```json
{
  "proofVersion": "1",
  "language": "Solidity",
  "contract": {
    "path": "examples/sample-contract/Counter.sol",
    "name": "Counter"
  },
  "compiler": {
    "version": "0.8.34+commit.80d5c536.Emscripten.clang",
    "settings": {
      "optimizer": { "enabled": true, "runs": 200 },
      "outputSelection": {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] }
      }
    }
  },
  "sourceBundle": {
    "language": "Solidity",
    "sources": {
      "examples/sample-contract/Counter.sol": {
        "content": "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.26;\n\ncontract Counter {\n    uint256 public count;\n    function increment() external { count++; }\n    function decrement() external { count--; }\n    function reset() external { count = 0; }\n}"
      }
    },
    "settings": {
      "optimizer": { "enabled": true, "runs": 200 },
      "outputSelection": {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] }
      }
    }
  },
  "artifacts": {
    "creationBytecode": "0x6080604052...",
    "creationBytecodeHash": "0x...",
    "runtimeBytecode": "0x6080604052...",
    "runtimeBytecodeHash": "0xd03e50f96b3f28d8c1d79e364f9073e9a3df852b4fd3940e2651a240fd29e7cd"
  },
  "attestation": {
    "codeHash":   "0xd03e50f96b3f28d8c1d79e364f9073e9a3df852b4fd3940e2651a240fd29e7cd",
    "sourceHash": "0xd27df30bc2d2473f5eff1a64db2931e1a10a1174d71171c125a69a0e250a3e39",
    "proofHash":  "0x185fa9389388ce37d6ec27ed51609e943cc4b653249e720eeae1f0c9859fea89"
  },
  "deployments": [
    { "chainId": 421614, "address": "0xBf54c6cD835aFDaFDeBd3e9a31F6E5c860C99AE8" },
    { "chainId": 84532,  "address": "0xBf54c6cD835aFDaFDeBd3e9a31F6E5c860C99AE8" }
  ],
  "metadata": {
    "createdAt": "2026-04-20T00:00:00.000Z",
    "tooling": { "sdk": "0.1.0" }
  }
}
```

---

## IPFS Storage

Proofs are pinned as JSON using CIDv1 with the `dag-pb` codec (the Pinata default). The IPFS CID is stored in the `VerificationRegistry` contract alongside the `proofHash`.

To retrieve a proof given its `ipfsCid`:

```
GET https://gateway.pinata.cloud/ipfs/{ipfsCid}
```

---

## On-Chain Anchoring

The `VerificationRegistry` contract (deployed on Ethereum L1) stores:

```
submitProof(proofHash, codeHash, sourceHash, compilerVersion, ipfsCid)
```

- `proofHash` — uniquely identifies this proof
- `codeHash` — the primary lookup key for all chains
- `sourceHash` — commits the source (enables future re-verification)
- `compilerVersion` — human-readable; the full version string is in the IPFS document
- `ipfsCid` — pointer to the full proof JSON on IPFS

The registry emits `ProofSubmitted(codeHash, proofHash, sourceHash, compilerVersion, ipfsCid, submitter)` which is indexed by the resolver API.

---

## Verification Procedure

To independently verify a proof:

1. Fetch the proof JSON from IPFS using `ipfsCid`
2. Recompute `codeHash = keccak256(hex_decode(artifacts.runtimeBytecode))`
3. Recompute `sourceHash = keccak256(utf8_encode(JSON.stringify(sourceBundle)))`
4. Recompute `proofHash = keccak256(concat(codeHash, sourceHash))`
5. Assert all three match `attestation.*`
6. Assert `proofExists[proofHash]` returns `true` on the L1 registry
7. Optionally: recompile `sourceBundle` with `compiler.version` + `compiler.settings`, compare output `deployedBytecode` against `artifacts.runtimeBytecode`

---

## Versioning

The `proofVersion` field is a string literal. Incompatible changes increment it (e.g. `"2"`). The registry and SDK treat unknown versions as unverifiable.

Current version: **`"1"`**

Future versions may add:
- `"language": "Vyper"` support
- Constructor arguments field
- Metadata hash verification
- Partial match (`runtimeBytecode` prefix match ignoring appended metadata)
