import Database from "better-sqlite3";

import type { IndexedDeployment, IndexedProof, IndexState, IndexStore } from "./types.js";

export interface SqliteIndexStoreOptions {
  path: string;
}

export class SqliteIndexStore implements IndexStore {
  private readonly _db: Database.Database;

  constructor(options: SqliteIndexStoreOptions) {
    this._db = new Database(options.path);
    this._db.pragma("journal_mode = WAL");
    this._db.pragma("synchronous = NORMAL");
    this._migrate();
  }

  private _migrate(): void {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS proofs (
        proof_hash TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        compiler_version TEXT NOT NULL,
        ipfs_cid TEXT NOT NULL,
        submitter TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proofs_code_hash ON proofs(code_hash);

      CREATE TABLE IF NOT EXISTS deployments (
        code_hash TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        address TEXT NOT NULL,
        submitter TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        PRIMARY KEY (code_hash, chain_id, address)
      );

      CREATE INDEX IF NOT EXISTS idx_deployments_code_hash ON deployments(code_hash);
      CREATE INDEX IF NOT EXISTS idx_deployments_chain ON deployments(code_hash, chain_id);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  addProof(proof: IndexedProof): void {
    const stmt = this._db.prepare(`
      INSERT OR IGNORE INTO proofs (proof_hash, code_hash, source_hash, compiler_version, ipfs_cid, submitter, block_number, transaction_hash, log_index)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      proof.proofHash,
      proof.codeHash,
      proof.sourceHash,
      proof.compilerVersion,
      proof.ipfsCid,
      proof.submitter,
      proof.blockNumber,
      proof.transactionHash,
      proof.logIndex,
    );

    this._updateLastBlock(proof.blockNumber);
  }

  addDeployment(deployment: IndexedDeployment): void {
    const stmt = this._db.prepare(`
      INSERT OR IGNORE INTO deployments (code_hash, chain_id, address, submitter, block_number, transaction_hash, log_index)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      deployment.codeHash,
      deployment.chainId,
      deployment.address,
      deployment.submitter,
      deployment.blockNumber,
      deployment.transactionHash,
      deployment.logIndex,
    );

    this._updateLastBlock(deployment.blockNumber);
  }

  proofsByCodeHash(codeHash: string): IndexedProof[] {
    const stmt = this._db.prepare(
      "SELECT * FROM proofs WHERE code_hash = ? ORDER BY block_number ASC",
    );
    return stmt.all(codeHash.toLowerCase()).map(rowToProof);
  }

  deploymentsByCodeHash(codeHash: string): IndexedDeployment[] {
    const stmt = this._db.prepare(
      "SELECT * FROM deployments WHERE code_hash = ? ORDER BY block_number ASC",
    );
    return stmt.all(codeHash.toLowerCase()).map(rowToDeployment);
  }

  deploymentsByChain(codeHash: string, chainId: number): IndexedDeployment[] {
    const stmt = this._db.prepare(
      "SELECT * FROM deployments WHERE code_hash = ? AND chain_id = ? ORDER BY block_number ASC",
    );
    return stmt.all(codeHash.toLowerCase(), chainId).map(rowToDeployment);
  }

  chainIdsByCodeHash(codeHash: string): number[] {
    const stmt = this._db.prepare(
      "SELECT DISTINCT chain_id FROM deployments WHERE code_hash = ? ORDER BY chain_id ASC",
    );
    return stmt.all(codeHash.toLowerCase()).map((row: any) => row.chain_id as number);
  }

  proofByHash(proofHash: string): IndexedProof | undefined {
    const stmt = this._db.prepare("SELECT * FROM proofs WHERE proof_hash = ?");
    const row = stmt.get(proofHash.toLowerCase());
    return row ? rowToProof(row) : undefined;
  }

  state(): IndexState {
    const proofCount = (this._db.prepare("SELECT COUNT(*) as cnt FROM proofs").get() as any).cnt;
    const deploymentCount = (this._db.prepare("SELECT COUNT(*) as cnt FROM deployments").get() as any).cnt;
    const chainCount = (this._db.prepare("SELECT COUNT(DISTINCT chain_id) as cnt FROM deployments").get() as any).cnt;

    return {
      lastBlockNumber: this.lastBlockNumber,
      proofCount,
      deploymentCount,
      chainCount,
    };
  }

  get lastBlockNumber(): number {
    const row = this._db.prepare("SELECT value FROM meta WHERE key = 'lastBlockNumber'").get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  close(): void {
    this._db.close();
  }

  private _updateLastBlock(blockNumber: number): void {
    if (blockNumber > this.lastBlockNumber) {
      this._db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('lastBlockNumber', ?)",
      ).run(String(blockNumber));
    }
  }
}

function rowToProof(row: any): IndexedProof {
  return {
    proofHash: row.proof_hash,
    codeHash: row.code_hash,
    sourceHash: row.source_hash,
    compilerVersion: row.compiler_version,
    ipfsCid: row.ipfs_cid,
    submitter: row.submitter,
    blockNumber: row.block_number,
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
  };
}

function rowToDeployment(row: any): IndexedDeployment {
  return {
    codeHash: row.code_hash,
    chainId: row.chain_id,
    address: row.address,
    submitter: row.submitter,
    blockNumber: row.block_number,
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
  };
}
