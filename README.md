# cross-l2-verify

Verify an EVM contract once, anchor the proof on Ethereum L1, and reuse it across every L2 where the same runtime bytecode is deployed.

## How It Works

1. **Verify** — Recompile source with `solc-js`, compare runtime bytecode against the deployed contract, build a verification proof, pin it to IPFS, and anchor hashes on L1.
2. **Propagate** — Find the same bytecode on another chain and register the deployment on L1 without resubmitting source.
3. **Lookup** — Query the L1 registry by address or `keccak256(runtimeBytecode)` to retrieve proofs and all known deployments.

The primary key is `keccak256(runtimeBytecode)`. One proof covers every chain where that bytecode exists.

## Architecture

```
docs/spec/                   Proof format spec, protocol spec, ERC-7744 integration
packages/contracts/          Solidity registry contract (Foundry)
packages/sdk/                TypeScript SDK — verify, lookup, propagate
packages/cli/                CLI wrapping the SDK
packages/tooling/            Shared Foundry/Hardhat hook helpers
packages/hardhat/            Hardhat plugin for post-deploy verification
packages/foundry/            Foundry plugin for post-deploy verification
packages/indexer/            Event indexer for scalable registry reads
packages/explorer-client/    Lightweight client for block explorer integration
packages/resolver-api/       HTTP resolver with cached IPFS lookups and live indexing
packages/integration/        End-to-end demo with 3 local Anvil chains
examples/                    Sample contracts
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

# Batch propagate across multiple chains
pnpm cli propagate-batch \
  --address 0x... \
  --chains "10=https://mainnet.optimism.io,42161=https://arb1.arbitrum.io/rpc" \
  --l1-rpc $L1_RPC \
  --registry $REGISTRY \
  --concurrency 5

# Check verification status
pnpm cli status \
  --code-hash 0x... \
  --l1-rpc $L1_RPC \
  --registry $REGISTRY

# Re-verify a proof independently (recompiles from source)
pnpm cli reverify --cid bafkrei...

# Re-verify from a local proof file
pnpm cli reverify --proof-file proof.json

# Import verified source from Etherscan and cross-L2 verify
pnpm cli import-etherscan \
  --address 0x... \
  --source-chain-id 1 \
  --target-rpc $L2_RPC \
  --target-chain-id 10 \
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

# With persistent SQLite storage
SQLITE_PATH=./data/index.db L1_RPC_URL=$L1_RPC REGISTRY_ADDRESS=$REGISTRY pnpm resolver:dev
```

Endpoints:

```
GET /health
GET /codehash/:codeHash                  Proofs and deployments for a bytecode hash
GET /codehash/:codeHash/deployments      Indexed deployments (?chainId=&limit=&offset=)
GET /codehash/:codeHash/chains           Chain IDs where the bytecode is deployed
GET /chains/:chainId/addresses/:address  Lookup by on-chain address (?rpc=)
GET /proofs/:proofHash                   Single proof with full IPFS payload
GET /indexer/status                      Proof count, deployment count, last synced block
GET /events                              SSE event stream for real-time status updates
```

The resolver boots an event indexer on startup that syncs historical events and live-polls for new ones. IPFS proof fetches are LRU-cached (default 500 entries). Set `SQLITE_PATH` for persistent storage across restarts.

## Explorer Client

Zero-dependency client for block explorers to integrate verification lookups:

```ts
import { ResolverClient } from "@cross-l2-verify/explorer-client";

const client = new ResolverClient({ baseUrl: "https://resolver.example.com" });

const verified = await client.isVerified(10, "0xContractAddress");
const result   = await client.lookupByCodeHash("0x...");
const chains   = await client.getChains("0x...");
const status   = await client.indexerStatus();
```

## Event Indexer

Syncs `ProofSubmitted` and `DeploymentRegistered` events from the registry into a store for fast queries without repeated on-chain reads.

```ts
import { MemoryIndexStore, SqliteIndexStore, syncToHead, startLiveSync } from "@cross-l2-verify/indexer";

// In-memory (for testing)
const store = new MemoryIndexStore();

// Or persistent SQLite (for production)
const store = new SqliteIndexStore({ path: "./data/index.db" });

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

## Docker

```sh
# Start resolver + dashboard
L1_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
REGISTRY_ADDRESS=0xFAb1DD3F94eBAA64FdB40623858cAC931cE8321c \
FROM_BLOCK=7880000 \
docker compose up

# Resolver on :3000, dashboard on :5173
# SQLite data persists in a Docker volume
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | For write operations | Wallet key for L1 transactions |
| `PINATA_JWT` | For IPFS pinning | Pinata API token |
| `IPFS_GATEWAY` | Optional | Custom IPFS gateway URL |
| `SOLC_BINARY` | Optional | Path to native solc binary |
| `ETHERSCAN_API_KEY` | Optional | Etherscan API key for import-etherscan |
| `SQLITE_PATH` | Optional | Path to SQLite file for persistent indexer storage |

When `PINATA_JWT` is not set, the integration demo uses an in-memory proof store.

## License

MIT
