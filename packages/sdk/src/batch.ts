import { type AbstractProvider, type ContractRunner } from "ethers";

import { propagate, type PropagateResult } from "./sdk.js";

export interface BatchPropagateTarget {
  chainId: number;
  address: string;
  provider: AbstractProvider;
}

export interface BatchPropagateOptions {
  registryAddress: string;
  registryRunner: ContractRunner;
  targets: BatchPropagateTarget[];
  expectedCodeHash?: `0x${string}`;
  concurrency?: number;
}

export interface BatchPropagateItemResult {
  chainId: number;
  address: string;
  success: boolean;
  result?: PropagateResult;
  error?: string;
}

export interface BatchPropagateResult {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchPropagateItemResult[];
}

export async function batchPropagate(options: BatchPropagateOptions): Promise<BatchPropagateResult> {
  const { targets, concurrency = 3 } = options;
  const results: BatchPropagateItemResult[] = [];
  const queue = [...targets];

  const worker = async () => {
    while (queue.length > 0) {
      const target = queue.shift()!;
      try {
        const result = await propagate({
          registryAddress: options.registryAddress,
          registryRunner: options.registryRunner,
          targetProvider: target.provider,
          targetAddress: target.address,
          targetChainId: target.chainId,
          expectedCodeHash: options.expectedCodeHash,
        });

        results.push({
          chainId: target.chainId,
          address: target.address,
          success: true,
          result,
        });
      } catch (error) {
        results.push({
          chainId: target.chainId,
          address: target.address,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker),
  );

  return {
    total: targets.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  };
}
