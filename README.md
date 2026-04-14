# cross-l2-verify

Verify an EVM contract once, anchor the proof on Ethereum L1, and reuse it across every L2 where the same runtime bytecode is deployed.

## How It Works

1. **Verify** — Recompile source with `solc-js`, compare runtime bytecode against the deployed contract, build a verification proof, pin it to IPFS, and anchor hashes on L1.
2. **Propagate** — Find the same bytecode on another chain and register the deployment on L1 without resubmitting source.
3. **Lookup** — Query the L1 registry by address or `keccak256(runtimeBytecode)` to retrieve proofs and all known deployments.

The primary key is `keccak256(runtimeBytecode)`. One proof covers every chain where that bytecode exists.

## Architecture

```
docs/spec/                 Proof format spec, protocol spec, ERC-7744 integration
packages/contracts/        Solidity registry contract (Foundry)
packages/sdk/              TypeScript SDK — verify, lookup, propagate
packages/cli/              CLI wrapping the SDK
packages/tooling/          Shared Foundry/Hardhat hook helpers
packages/hardhat/          Hardhat plugin for post-deploy verification
packages/foundry/          Foundry plugin for post-deploy verification
packages/indexer/          Event indexer for scalable registry reads
packages/resolver-api/     HTTP resolver with LRU-cached IPFS lookups
packages/integration/      End-to-end demo with 3 local Anvil chains
examples/                  Sample contracts
```

## Prerequisites

- Node.js >= 18
- [pnpm](https://pnpm.io/) >= 10
- [Foundry](https://getfoundry.sh/) (for contract compilation and tests)

## Setup

```sh
pnpm install
pnpm build
pnpm test
```

If Foundry cannot download `solc` automatically:

```sh
brew install solidity
export SOLC_BINARY=$(which solc)
```

## CLI

```sh
# Verify a contract
pnpm cli verify \
  --input compiler-input.json \
  --contract-path src/Counter.sol \
  --contract-name Counter \
  --address 0x... \
  --chain-id 421614 \
  --target-rpc $L2_RPC \
  --l1-rpc $L1_RPC \
  --registry $REGISTRY \
  --compiler-version 0.8.26

# Lookup by code hash
pnpm cli lookup \
  --code-hash 0x... \
  --l1-rpc $L1_RPC \
  --registry $REGISTRY

# Propagate to another chain
pnpm cli propagate \
  --address 0x... \
  --chain-id 84532 \
  --target-rpc $L2B_RPC \
  --l1-rpc $L1_RPC \
  --registry $REGISTRY

# Check verification status
pnpm cli status \
  --code-hash 0x... \
  --l1-rpc $L1_RPC \
  --registry $REGISTRY
```

## Deploy Hooks

Both hooks call `verifyOrPropagate` — they submit a fresh proof or fall back to propagation if the proof already exists on L1.

**Foundry:**

```sh
pnpm cli hook:foundry \
  --broadcast-file broadcast/Deploy.s.sol/421614/run-latest.json \
  --input compiler-input.json \
  --contract-name Counter \
  --contract-path src/Counter.sol \
  --target-rpc $L2_RPC \
  --l1-rpc $L1_RPC \
  --registry $REGISTRY \
  --compiler-version 0.8.26
```

**Hardhat:**

```sh
pnpm cli hook:hardhat \
  --build-info artifacts/build-info/<id>.json \
  --deployment-file deployments/base-sepolia/Counter.json \
  --contract-name Counter \
  --target-rpc $L2_RPC \
  --l1-rpc $L1_RPC \
  --registry $REGISTRY
```

## Resolver API

```sh
L1_RPC_URL=$L1_RPC REGISTRY_ADDRESS=$REGISTRY pnpm resolver:dev
```

Endpoints:

```
GET /codehash/:codeHash
GET /chains/:chainId/addresses/:address
GET /proofs/:proofHash
GET /health
```

The resolver uses an LRU cache for IPFS proof fetches. Set `IPFS_CACHE_SIZE` to tune (default 500).

## Event Indexer

The indexer package syncs `ProofSubmitted` and `DeploymentRegistered` events from the registry into an in-memory store for fast queries without repeated on-chain reads.

```ts
import { MemoryIndexStore, syncToHead, startLiveSync } from "@cross-l2-verify/indexer";

const store = new MemoryIndexStore();
await syncToHead({ provider, registryAddress, store });

store.proofsByCodeHash("0x...");
store.deploymentsByChain("0x...", 10);
store.chainIdsByCodeHash("0x...");
```

## Integration Demo

Spins up 3 local Anvil chains, deploys the registry on L1, deploys a sample contract via CREATE2 on both L2s, verifies on one, and propagates to the other.

```sh
pnpm integration:test
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | For write operations | Wallet key for L1 transactions |
| `PINATA_JWT` | For IPFS pinning | Pinata API token |
| `IPFS_GATEWAY` | Optional | Custom IPFS gateway URL |
| `SOLC_BINARY` | Optional | Path to native solc binary |

When `PINATA_JWT` is not set, the integration demo uses an in-memory proof store.

## License

MIT
