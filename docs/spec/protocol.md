# Protocol Overview

## Actors

- `Submitter`: compiles code, creates a proof, pins it to IPFS, and submits the anchor to L1.
- `Registry`: immutable L1 contract that stores proof anchors and deployment registrations.
- `Resolver`: offchain service or SDK that revalidates proofs and serves normalized lookup responses.
- `Consumer`: block explorer, wallet, indexer, or developer tool.

## Registry Model

The registry is intentionally attestation-based.

- A proof is immutable once submitted.
- A deployment registration is immutable once recorded.
- Multiple proofs may exist for the same `codeHash`.
- The resolver decides whether a proof is valid by replaying the build and bytecode comparison.

This avoids assigning permanent canonical status to an unverified first submitter.

## Flow: `verify()`

1. Fetch deployed runtime bytecode from the target chain.
2. Recompile the declared source bundle with `solc-js`.
3. Compare compiled runtime bytecode to deployed runtime bytecode.
4. Build the proof object and derive `codeHash`, `sourceHash`, and `proofHash`.
5. Pin the full proof object to IPFS.
6. Submit the proof anchor to the L1 registry.
7. Register the known deployment under `codeHash -> chainId -> address`.

## Flow: `lookup()`

1. Resolve an address to runtime bytecode and `codeHash`, or use a provided `codeHash`.
2. Query the L1 registry for proof hashes and registered deployments.
3. Fetch each proof from IPFS.
4. Validate the proof contents and hashes.
5. Return normalized records to the caller.

## Flow: `propagate()`

1. Fetch runtime bytecode from the target chain and target address.
2. Confirm its `codeHash` matches an already anchored proof.
3. Register the new deployment on L1 without resubmitting source material.

## Resolver Guarantees

The resolver should never trust IPFS or onchain metadata blindly. It must:

- validate the proof schema,
- recompute every advertised hash,
- ensure the onchain anchor and IPFS payload agree,
- optionally retry multiple IPFS gateways before failing.

## Minimal API Shape

- `GET /codehash/:codeHash`
- `GET /chains/:chainId/addresses/:address`
- `GET /proofs/:proofHash`
- `GET /health`

## Data Model Notes

- `codeHash` is the portability key.
- `proofHash` uniquely identifies a submitted proof payload.
- chain-specific registration is separate from source verification.
- event indexing is the long-term scalability path; direct array reads are acceptable for the prototype.
