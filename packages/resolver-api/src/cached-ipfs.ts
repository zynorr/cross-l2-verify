import type { IpfsPinClient, PinJsonResult } from "@cross-l2-verify/sdk";

import { LRUCache } from "./cache.js";

export class CachedIpfsClient implements IpfsPinClient {
  private readonly _cache: LRUCache<string, unknown>;

  constructor(
    private readonly _inner: IpfsPinClient,
    maxCacheSize = 500,
  ) {
    this._cache = new LRUCache(maxCacheSize);
  }

  async pinJson(payload: unknown, options?: { name?: string }): Promise<PinJsonResult> {
    const result = await this._inner.pinJson(payload, options);
    this._cache.set(result.cid, structuredClone(payload));
    return result;
  }

  async fetchJson<T>(cid: string): Promise<T> {
    const cached = this._cache.get(cid);
    if (cached !== undefined) {
      return structuredClone(cached) as T;
    }

    const result = await this._inner.fetchJson<T>(cid);
    this._cache.set(cid, structuredClone(result));
    return result;
  }

  get cacheSize(): number {
    return this._cache.size;
  }
}
