# cross-l2-verify

Cross-L2 Contract Verification Registry is a prototype for verifying an EVM contract once and anchoring that verification proof on Ethereum L1 so the same runtime bytecode can be trusted across many L2s.

## Prototype Scope

- M1: Verification proof format spec
- M2: L1 `VerificationRegistry` contract and submission SDK
- M3: Resolver API for explorers, wallets, and indexers
- M4: CLI and plugin-ready integration surface

## Design Summary

- Primary key: `keccak256(runtimeBytecode)`
- Full verification proof lives on IPFS
- L1 stores immutable proof anchors and deployment registrations
- Resolution is chain-agnostic: one proof can back many L2 addresses if the runtime bytecode matches

## Workspace Layout

```text
docs/spec/                 Protocol and proof format documents
packages/contracts/        Foundry contract package
packages/sdk/              TypeScript SDK for verify/lookup/propagate
packages/cli/              CLI for verify/lookup/propagate/status
packages/resolver-api/     HTTP resolver for explorers and wallets
packages/integration/      Multi-Anvil integration harness and CREATE2 demo flow
examples/sample-contract/  Small Solidity contract used in demos
```

## Getting Started

1. Install dependencies with `pnpm install`.
2. If Foundry cannot fetch `solc` automatically, download a native compiler binary and export `SOLC_BINARY=/path/to/solc`.
3. Run the full build with `SOLC_BINARY=/path/to/solc pnpm build`.
4. Run the full test suite with `SOLC_BINARY=/path/to/solc pnpm test`.
5. Start the resolver locally with `pnpm resolver:dev`.

## CLI Commands

- `pnpm cli verify --input compiler-input.json --contract-path src/Counter.sol --contract-name Counter --address 0x... --chain-id 421614 --target-rpc http://127.0.0.1:9545 --l1-rpc http://127.0.0.1:8545 --registry 0x... --compiler-version 0.8.26`
- `pnpm cli lookup --code-hash 0x... --l1-rpc http://127.0.0.1:8545 --registry 0x...`
- `pnpm cli propagate --address 0x... --chain-id 84532 --target-rpc http://127.0.0.1:10545 --l1-rpc http://127.0.0.1:8545 --registry 0x...`
- `pnpm integration:test` runs the real 3-Anvil CREATE2 verification and propagation demo.
- `pnpm --filter @cross-l2-verify/integration demo:plan` prints the planned flow without starting chains.
- `pnpm --filter @cross-l2-verify/integration demo:live-ipfs` requires `PINATA_JWT` and keeps the three local chains alive after a live Pinata/IPFS-backed run.

## Deploy Hooks

Both deploy-hook commands call the SDK and automatically fall back from full `verify` to `propagate` when the proof is already anchored on L1.

- Foundry:
  `pnpm cli hook:foundry --broadcast-file broadcast/Deploy.s.sol/421614/run-latest.json --input compiler-input.json --contract-name Counter --contract-path src/Counter.sol --target-rpc http://127.0.0.1:9545 --l1-rpc http://127.0.0.1:8545 --registry 0x... --compiler-version 0.8.26 --private-key $PRIVATE_KEY --pinata-jwt $PINATA_JWT`
- Hardhat:
  `pnpm cli hook:hardhat --build-info artifacts/build-info/<id>.json --deployment-file deployments/base-sepolia/Counter.json --contract-name Counter --target-rpc http://127.0.0.1:9545 --l1-rpc http://127.0.0.1:8545 --registry 0x... --private-key $PRIVATE_KEY --pinata-jwt $PINATA_JWT`

## IPFS Modes

- If `PINATA_JWT` is set, the integration demo pins proofs to Pinata and resolves them through the configured IPFS gateway.
- If `PINATA_JWT` is not set, the demo falls back to an in-memory proof store so `pnpm test` stays deterministic and fast.

## Current Status

This repository now has the first end-to-end prototype slice in place: proof spec, L1 registry contract, SDK core, CLI, resolver API, a passing multi-Anvil CREATE2 demo, live Pinata/IPFS support for the demo when configured, and Foundry/Hardhat deploy-hook commands on top of the CLI/SDK. The next iteration is to turn the Hardhat and Foundry hooks into repo-installable packages and add explorer-facing resolver caching/indexing.
