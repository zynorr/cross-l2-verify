import type { IndexedDeployment, IndexedProof, IndexState, IndexStore } from "./types.js";

export class MemoryIndexStore implements IndexStore {
  private _proofs = new Map<string, IndexedProof>();
  private _codeHashToProofs = new Map<string, string[]>();
  private _codeHashToDeployments = new Map<string, IndexedDeployment[]>();
  private _lastBlockNumber = 0;

  addProof(proof: IndexedProof): void {
    if (this._proofs.has(proof.proofHash)) return;

    this._proofs.set(proof.proofHash, proof);

    const existing = this._codeHashToProofs.get(proof.codeHash) ?? [];
    existing.push(proof.proofHash);
    this._codeHashToProofs.set(proof.codeHash, existing);

    this._lastBlockNumber = Math.max(this._lastBlockNumber, proof.blockNumber);
  }

  addDeployment(deployment: IndexedDeployment): void {
    const existing = this._codeHashToDeployments.get(deployment.codeHash) ?? [];

    const duplicate = existing.some(
      (d) => d.chainId === deployment.chainId && d.address.toLowerCase() === deployment.address.toLowerCase(),
    );
    if (duplicate) return;

    existing.push(deployment);
    this._codeHashToDeployments.set(deployment.codeHash, existing);

    this._lastBlockNumber = Math.max(this._lastBlockNumber, deployment.blockNumber);
  }

  proofsByCodeHash(codeHash: string): IndexedProof[] {
    const hashes = this._codeHashToProofs.get(codeHash.toLowerCase()) ?? [];
    return hashes.map((h) => this._proofs.get(h)!).filter(Boolean);
  }

  deploymentsByCodeHash(codeHash: string): IndexedDeployment[] {
    return this._codeHashToDeployments.get(codeHash.toLowerCase()) ?? [];
  }

  deploymentsByChain(codeHash: string, chainId: number): IndexedDeployment[] {
    return this.deploymentsByCodeHash(codeHash).filter((d) => d.chainId === chainId);
  }

  chainIdsByCodeHash(codeHash: string): number[] {
    const deployments = this.deploymentsByCodeHash(codeHash);
    return [...new Set(deployments.map((d) => d.chainId))];
  }

  proofByHash(proofHash: string): IndexedProof | undefined {
    return this._proofs.get(proofHash.toLowerCase());
  }

  recentProofs(limit: number): IndexedProof[] {
    const all = [...this._proofs.values()];
    all.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    return all.slice(0, Math.max(0, limit));
  }

  recentDeployments(limit: number): IndexedDeployment[] {
    const all: IndexedDeployment[] = [];
    for (const list of this._codeHashToDeployments.values()) all.push(...list);
    all.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    return all.slice(0, Math.max(0, limit));
  }

  state(): IndexState {
    const chainIds = new Set<number>();
    for (const deployments of this._codeHashToDeployments.values()) {
      for (const d of deployments) chainIds.add(d.chainId);
    }

    return {
      lastBlockNumber: this._lastBlockNumber,
      proofCount: this._proofs.size,
      deploymentCount: Array.from(this._codeHashToDeployments.values()).reduce(
        (sum, d) => sum + d.length,
        0,
      ),
      chainCount: chainIds.size,
    };
  }

  get lastBlockNumber(): number {
    return this._lastBlockNumber;
  }
}
