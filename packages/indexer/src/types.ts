export interface IndexedProof {
  proofHash: string;
  codeHash: string;
  sourceHash: string;
  compilerVersion: string;
  ipfsCid: string;
  submitter: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface IndexedDeployment {
  codeHash: string;
  chainId: number;
  address: string;
  submitter: string;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

export interface IndexState {
  lastBlockNumber: number;
  proofCount: number;
  deploymentCount: number;
  chainCount?: number;
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface IndexQuery {
  proofsByCodeHash(codeHash: string): IndexedProof[];
  deploymentsByCodeHash(codeHash: string): IndexedDeployment[];
  deploymentsByChain(codeHash: string, chainId: number): IndexedDeployment[];
  chainIdsByCodeHash(codeHash: string): number[];
  proofByHash(proofHash: string): IndexedProof | undefined;
  recentProofs(limit: number): IndexedProof[];
  recentDeployments(limit: number): IndexedDeployment[];
  state(): IndexState;
}

export interface IndexStore extends IndexQuery {
  addProof(proof: IndexedProof): void;
  addDeployment(deployment: IndexedDeployment): void;
  readonly lastBlockNumber: number;
}
