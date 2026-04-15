export interface ResolverClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
}

export interface VerificationProof {
  codeHash: string;
  proofHash: string;
  sourceHash: string;
  compilerVersion: string;
  ipfsCid: string;
}

export interface LookupResult {
  codeHash: string;
  proofs: VerificationProof[];
  chainIds: number[];
  deploymentsByChain: Record<string, string[]>;
}

export interface IndexedDeployment {
  codeHash: string;
  chainId: number;
  address: string;
  submitter: string;
  blockNumber: number;
  transactionHash: string;
}

export interface IndexerStatus {
  lastBlockNumber: number;
  proofCount: number;
  deploymentCount: number;
}

export class ResolverClient {
  private readonly _baseUrl: string;
  private readonly _fetch: typeof fetch;

  constructor(options: ResolverClientOptions) {
    this._baseUrl = options.baseUrl.replace(/\/$/, "");
    this._fetch = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  }

  async health(): Promise<{ status: string }> {
    return this._get("/health");
  }

  async lookupByCodeHash(codeHash: string): Promise<LookupResult> {
    return this._get(`/codehash/${codeHash}`);
  }

  async lookupByAddress(chainId: number, address: string, rpc?: string): Promise<LookupResult> {
    const query = rpc ? `?rpc=${encodeURIComponent(rpc)}` : "";
    return this._get(`/chains/${chainId}/addresses/${address}${query}`);
  }

  async getProof(proofHash: string): Promise<VerificationProof & { proofPayload: unknown }> {
    return this._get(`/proofs/${proofHash}`);
  }

  async getDeployments(codeHash: string, chainId?: number): Promise<{ codeHash: string; deployments: IndexedDeployment[] }> {
    const query = chainId ? `?chainId=${chainId}` : "";
    return this._get(`/codehash/${codeHash}/deployments${query}`);
  }

  async getChains(codeHash: string): Promise<{ codeHash: string; chains: number[] }> {
    return this._get(`/codehash/${codeHash}/chains`);
  }

  async indexerStatus(): Promise<IndexerStatus> {
    return this._get("/indexer/status");
  }

  async isVerified(chainId: number, address: string, rpc?: string): Promise<boolean> {
    try {
      const result = await this.lookupByAddress(chainId, address, rpc);
      return result.proofs.length > 0;
    } catch {
      return false;
    }
  }

  private async _get<T>(path: string): Promise<T> {
    const response = await this._fetch(`${this._baseUrl}${path}`);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ResolverError(response.status, body, path);
    }

    return (await response.json()) as T;
  }
}

export class ResolverError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
  ) {
    super(`Resolver returned ${status} for ${path}: ${body}`);
    this.name = "ResolverError";
  }
}
