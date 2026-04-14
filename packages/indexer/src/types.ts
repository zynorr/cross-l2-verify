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
}

export interface IndexQuery {
  proofsByCodeHash(codeHash: string): IndexedProof[];
  deploymentsByCodeHash(codeHash: string): IndexedDeployment[];
  deploymentsByChain(codeHash: string, chainId: number): IndexedDeployment[];
  chainIdsByCodeHash(codeHash: string): number[];
  proofByHash(proofHash: string): IndexedProof | undefined;
  state(): IndexState;
}
