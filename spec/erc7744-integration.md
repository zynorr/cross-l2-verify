# ERC-7744 Integration

**Status:** Draft
**Authors:** cross-l2-verify

---

## Overview

[ERC-7744](https://eips.ethereum.org/EIPS/eip-7744) (Code Index) proposes a minimal on-chain registry that maps `keccak256(bytecode)` to every address where that bytecode is deployed. It answers: **"Where is this bytecode deployed?"**

`cross-l2-verify` answers a complementary question: **"Has this bytecode been verified, and against what source code?"**

The two systems use the same primary key — `keccak256(runtimeBytecode)` — making them naturally composable. This document describes how they relate, how they can be used together, and how a cross-l2-verify deployment integrates with ERC-7744 indexers.

---

## ERC-7744 Summary

ERC-7744 defines a singleton contract deployed at the same address on every EVM chain (via Nick's deterministic factory). It exposes:

```solidity
interface ICodeIndex {
    event Indexed(bytes32 indexed codeHash, address indexed container);
    function register(address container) external;
    function get(bytes32 codeHash) external view returns (address);
}
```

- `register(address)` — records `keccak256(extcodecopy(address))` → `address` on the current chain
- `get(bytes32)` — returns one (arbitrary) address for that bytecode hash on the current chain
- Deployments on each chain must be registered separately (no cross-chain messaging)

---

## Relationship to cross-l2-verify

| Concern | ERC-7744 | cross-l2-verify |
|---|---|---|
| Primary key | `keccak256(runtimeBytecode)` | `keccak256(runtimeBytecode)` |
| Stores | `codeHash → address` (per-chain) | `codeHash → verificationProof` (L1, cross-chain) |
| Cross-chain | No — per-chain registry | Yes — single L1 registry covers all chains |
| Source code | No | Yes — full Solidity source + compiler input on IPFS |
| Authoritativeness | Any deployer can register | Any submitter can verify (first-come) |
| Gas cost | Low (single SSTORE per registration) | Medium (L1 tx to anchor proof hash) |

The systems are **additive, not competing**:
- ERC-7744 tells you *where* a bytecode lives
- cross-l2-verify tells you *what* the bytecode is (source, compiler, audit trail)

---

## Integration Patterns

### Pattern 1: Proof-then-Register

After verifying a contract via cross-l2-verify, optionally register in ERC-7744 on each target chain to make the deployment discoverable by ERC-7744 indexers.

```
[Deploy contract] → [cross-l2-verify: submitProof] → [ERC-7744: register on each chain]
```

The SDK's `propagate()` call can be extended to call `ICodeIndex.register(address)` as a post-step.

### Pattern 2: Register-then-Verify

ERC-7744 indexers can subscribe to `Indexed` events, extract the `codeHash`, and look it up in the cross-l2-verify resolver to surface verification status.

```
[ERC-7744: Indexed event] → [cross-l2-verify: GET /codehash/:codeHash] → verification status
```

This enables block explorers and wallets that consume ERC-7744 to display a "verified" badge without directly integrating with cross-l2-verify.

### Pattern 3: Unified Lookup

A dapp or explorer given only an address on any chain can:

1. Call `eth_getCode(address)` → get bytecode
2. Compute `codeHash = keccak256(bytecode)`
3. Call `ICodeIndex.get(codeHash)` → find any deployed address (for ERC-7744 explorer UI)
4. Call cross-l2-verify resolver `GET /codehash/{codeHash}` → get proof and all verified deployments

Steps 3 and 4 run in parallel; neither depends on the other.

---

## Shared Key Design

Both systems deliberately use `keccak256(runtimeBytecode)` as their primary key. This choice:

- Is chain-agnostic — same bytecode deployed on 10 chains has exactly one key
- Requires no coordination between the two systems
- Enables deterministic CREATE2-deployed contracts to be registered/verified once and looked up everywhere
- Avoids the address-reuse ambiguity present in per-chain address mappings

---

## On-Chain Composability

A single Solidity contract can integrate both registries:

```solidity
interface ICodeIndex {
    function register(address container) external;
    function get(bytes32 codeHash) external view returns (address);
}

interface IVerificationRegistry {
    function proofExists(bytes32 proofHash) external view returns (bool);
    function getVerification(bytes32 proofHash) external view returns (
        bytes32 codeHash, bytes32 sourceHash, string memory compilerVersion,
        string memory ipfsCid, address submitter, uint64 submittedAt
    );
}

contract VerifiedCodeLookup {
    ICodeIndex constant CODE_INDEX = ICodeIndex(0x...);           // ERC-7744
    IVerificationRegistry constant REGISTRY = IVerificationRegistry(0x...); // cross-l2-verify

    /// Returns true if the code at `addr` has a proof in the cross-l2-verify registry.
    function isVerified(address addr, bytes32 proofHash) external view returns (bool) {
        bytes32 codeHash = keccak256(addr.code);
        (, bytes32 storedCodeHash,,,, ) = REGISTRY.getVerification(proofHash);
        return REGISTRY.proofExists(proofHash) && storedCodeHash == codeHash;
    }

    /// Returns an arbitrary address for this bytecode via ERC-7744.
    function canonicalAddress(address addr) external view returns (address) {
        return CODE_INDEX.get(keccak256(addr.code));
    }
}
```

---

## Differences in Trust Model

**ERC-7744** is fully permissionless and opinionless about source code. Any address can be registered by anyone. It makes no claim about what the code does.

**cross-l2-verify** is also permissionless (anyone can submit a proof), but includes a source-code commitment. A proof with a wrong `sourceHash` that doesn't match the actual IPFS content would be detectable by anyone recomputing the hashes. The trust assumption is that the Ethereum L1 timestamp and `submitter` address are publicly auditable.

Neither system offers slashing or economic guarantees about proof correctness — both rely on social auditability and the ability for anyone to re-verify.

---

## Recommended Usage for Block Explorers

Block explorers wishing to display cross-chain verification status with minimal integration:

1. Subscribe to `ProofSubmitted(codeHash, proofHash, ...)` events from the `VerificationRegistry` on Ethereum L1
2. For any address lookup on any chain: compute `codeHash`, check local index
3. Display proof details fetched from the IPFS CID stored in the event

No ERC-7744 integration is required for this — but ERC-7744's `Indexed` events can supplement the feed with deployment registrations that haven't gone through cross-l2-verify yet.

---

## Registry Addresses

| Contract | Network | Address |
|---|---|---|
| VerificationRegistry | Sepolia (testnet) | `0xFAb1DD3F94eBAA64FdB40623858cAC931cE8321c` |
| VerificationRegistry | Ethereum Mainnet | TBD (pre-mainnet) |
| ERC-7744 Code Index | All EVM chains | `0x...` (pending EIP finalization) |

---

## Future Work

- **Joint propagation**: When `propagate()` is called to register a deployment on a new chain, also call `ICodeIndex.register()` on that chain automatically
- **ERC-7744 event bridge**: Index `Indexed` events to suggest unverified deployments that could be propagated into cross-l2-verify
- **Unified resolver endpoint**: `GET /erc7744/:codeHash` that returns both ERC-7744 registered addresses and cross-l2-verify proofs in a single response
