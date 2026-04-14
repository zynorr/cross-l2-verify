# ERC-7744 Integration

## Background

[ERC-7744 (Code Index)](https://eips.ethereum.org/EIPS/eip-7744) defines a minimal on-chain registry that maps `keccak256(runtimeBytecode)` to deployed addresses. It answers "where is this bytecode deployed?" but says nothing about whether the bytecode is verified or what source produced it.

Cross-L2 Verify builds a complementary layer: given the same `codeHash`, it stores a verification proof that binds source code, compiler settings, and IPFS-hosted evidence to that bytecode image.

## Relationship

```
ERC-7744 Code Index          Cross-L2 Verify Registry
─────────────────            ────────────────────────
codeHash → address[]         codeHash → proofHash[]
                             codeHash → chainId → address[]
                             proofHash → VerificationRecord
```

ERC-7744 tells you **where** bytecode lives. Cross-L2 Verify tells you **what source produced it** and anchors that claim immutably on L1.

## Shared Primary Key

Both systems use `keccak256(runtimeBytecode)` as the primary key. This is intentional: any consumer that already indexes via ERC-7744 can enrich its records with verification data from Cross-L2 Verify by joining on `codeHash`.

## Integration Patterns

### Pattern 1: Explorer enrichment

A block explorer that already consumes ERC-7744 events can query the Cross-L2 Verify registry (or resolver API) for the same `codeHash` to display source verification status alongside deployment locations.

```
1. Explorer sees DeploymentRegistered(codeHash, chainId, address) from ERC-7744.
2. Explorer queries Cross-L2 Verify: GET /codehash/{codeHash}
3. If proofs exist, display "Verified" with compiler version and IPFS link.
```

### Pattern 2: Wallet trust signals

A wallet that checks ERC-7744 to confirm code existence can additionally check Cross-L2 Verify to confirm that the code has been independently verified against published source.

### Pattern 3: Dual registration

The `submitProofAndRegister` function on the Cross-L2 Verify registry atomically submits a verification proof and registers a deployment. A future version could also call ERC-7744's `register` function in the same transaction to populate both registries at once.

## Design Differences

| Aspect | ERC-7744 | Cross-L2 Verify |
|--------|----------|-----------------|
| Scope | Bytecode location | Source verification |
| Storage | codeHash → addresses | codeHash → proofs + deployments |
| Proof data | None | Full compiler input, IPFS CID, hashes |
| Permissionless | Yes | Yes |
| Chain | Any EVM chain | Anchored on L1, references any chain |
| Verification | None (registry only) | Offchain recompilation + hash comparison |

## Future Convergence

If ERC-7744 gains adoption as a standard bytecode index, Cross-L2 Verify could:

1. Accept ERC-7744 event logs as proof of deployment instead of requiring explicit `registerDeployment` calls.
2. Provide a combined resolver that merges ERC-7744 location data with verification proofs into a single API response.
3. Propose an ERC extension that adds an optional `verificationProofHash` field to the Code Index registration.

## Out of Scope

This document does not propose changes to ERC-7744 itself. Cross-L2 Verify is designed to be composable with ERC-7744, not to replace or modify it.
