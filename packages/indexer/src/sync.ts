import { Contract, getAddress, type AbstractProvider, type EventLog } from "ethers";

import type { MemoryIndexStore } from "./store.js";
import type { IndexedDeployment, IndexedProof } from "./types.js";

const REGISTRY_EVENTS_ABI = [
  "event ProofSubmitted(bytes32 indexed codeHash, bytes32 indexed proofHash, bytes32 indexed sourceHash, string compilerVersion, string ipfsCid, address submitter)",
  "event DeploymentRegistered(bytes32 indexed codeHash, uint256 indexed chainId, address indexed deployment, address submitter)",
];

export interface SyncOptions {
  provider: AbstractProvider;
  registryAddress: string;
  store: MemoryIndexStore;
  fromBlock?: number;
  batchSize?: number;
}

export async function syncToHead(options: SyncOptions): Promise<number> {
  const { provider, registryAddress, store } = options;
  const batchSize = options.batchSize ?? 2000;
  const fromBlock = options.fromBlock ?? store.lastBlockNumber + 1;
  const headBlock = await provider.getBlockNumber();

  if (fromBlock > headBlock) return 0;

  const registry = new Contract(getAddress(registryAddress), REGISTRY_EVENTS_ABI, provider);
  let processed = 0;

  for (let start = fromBlock; start <= headBlock; start += batchSize) {
    const end = Math.min(start + batchSize - 1, headBlock);

    const [proofEvents, deploymentEvents] = await Promise.all([
      registry.queryFilter("ProofSubmitted", start, end),
      registry.queryFilter("DeploymentRegistered", start, end),
    ]);

    for (const event of proofEvents) {
      if (!("args" in event)) continue;
      const [codeHash, proofHash, sourceHash, compilerVersion, ipfsCid, submitter] = (event as EventLog).args;

      const proof: IndexedProof = {
        proofHash: (proofHash as string).toLowerCase(),
        codeHash: (codeHash as string).toLowerCase(),
        sourceHash: (sourceHash as string).toLowerCase(),
        compilerVersion: compilerVersion as string,
        ipfsCid: ipfsCid as string,
        submitter: getAddress(submitter as string),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.index,
      };

      store.addProof(proof);
      processed++;
    }

    for (const event of deploymentEvents) {
      if (!("args" in event)) continue;
      const [codeHash, chainId, deployment, submitter] = (event as EventLog).args;

      const indexed: IndexedDeployment = {
        codeHash: (codeHash as string).toLowerCase(),
        chainId: Number(chainId),
        address: getAddress(deployment as string),
        submitter: getAddress(submitter as string),
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
        logIndex: event.index,
      };

      store.addDeployment(indexed);
      processed++;
    }
  }

  return processed;
}

export interface LiveSyncOptions extends SyncOptions {
  onProof?: (proof: IndexedProof) => void;
  onDeployment?: (deployment: IndexedDeployment) => void;
  pollIntervalMs?: number;
}

export function startLiveSync(options: LiveSyncOptions): { stop: () => void } {
  const pollIntervalMs = options.pollIntervalMs ?? 12_000;
  let running = true;

  const tick = async () => {
    if (!running) return;

    try {
      await syncToHead(options);
    } catch {
      // Retry on next tick.
    }

    if (running) {
      setTimeout(tick, pollIntervalMs);
    }
  };

  tick();

  return {
    stop() {
      running = false;
    },
  };
}
