import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { SqliteIndexStore } from "./sqlite-store.js";
import type { IndexedDeployment, IndexedProof } from "./types.js";

function tempDb(): string {
  return join(tmpdir(), `test-${randomBytes(8).toString("hex")}.db`);
}

function makeProof(overrides: Partial<IndexedProof> = {}): IndexedProof {
  return {
    proofHash: "0x" + randomBytes(32).toString("hex"),
    codeHash: "0x" + randomBytes(32).toString("hex"),
    sourceHash: "0x" + randomBytes(32).toString("hex"),
    compilerVersion: "0.8.26",
    ipfsCid: "bafkrei" + randomBytes(16).toString("hex"),
    submitter: "0x" + randomBytes(20).toString("hex"),
    blockNumber: 100,
    transactionHash: "0x" + randomBytes(32).toString("hex"),
    logIndex: 0,
    ...overrides,
  };
}

function makeDeployment(overrides: Partial<IndexedDeployment> = {}): IndexedDeployment {
  return {
    codeHash: "0x" + randomBytes(32).toString("hex"),
    chainId: 10,
    address: "0x" + randomBytes(20).toString("hex"),
    submitter: "0x" + randomBytes(20).toString("hex"),
    blockNumber: 100,
    transactionHash: "0x" + randomBytes(32).toString("hex"),
    logIndex: 0,
    ...overrides,
  };
}

test("sqlite: add and retrieve proof", () => {
  const store = new SqliteIndexStore({ path: tempDb() });
  const proof = makeProof();
  store.addProof(proof);

  const fetched = store.proofByHash(proof.proofHash);
  assert.ok(fetched);
  assert.equal(fetched.proofHash, proof.proofHash);
  assert.equal(fetched.codeHash, proof.codeHash);
  assert.equal(fetched.compilerVersion, "0.8.26");
  store.close();
});

test("sqlite: duplicate proof is ignored", () => {
  const store = new SqliteIndexStore({ path: tempDb() });
  const proof = makeProof();
  store.addProof(proof);
  store.addProof(proof);

  assert.equal(store.state().proofCount, 1);
  store.close();
});

test("sqlite: proofsByCodeHash returns matching proofs", () => {
  const store = new SqliteIndexStore({ path: tempDb() });
  const codeHash = "0xaabb";
  const p1 = makeProof({ codeHash, blockNumber: 10 });
  const p2 = makeProof({ codeHash, blockNumber: 20 });
  const p3 = makeProof({ codeHash: "0xccdd" });

  store.addProof(p1);
  store.addProof(p2);
  store.addProof(p3);

  const results = store.proofsByCodeHash(codeHash);
  assert.equal(results.length, 2);
  store.close();
});

test("sqlite: add and retrieve deployment", () => {
  const store = new SqliteIndexStore({ path: tempDb() });
  const dep = makeDeployment();
  store.addDeployment(dep);

  const results = store.deploymentsByCodeHash(dep.codeHash);
  assert.equal(results.length, 1);
  assert.equal(results[0].chainId, dep.chainId);
  assert.equal(results[0].address, dep.address);
  store.close();
});

test("sqlite: duplicate deployment is ignored", () => {
  const store = new SqliteIndexStore({ path: tempDb() });
  const dep = makeDeployment();
  store.addDeployment(dep);
  store.addDeployment(dep);

  assert.equal(store.state().deploymentCount, 1);
  store.close();
});

test("sqlite: deploymentsByChain filters by chainId", () => {
  const store = new SqliteIndexStore({ path: tempDb() });
  const codeHash = "0xaabb";
  store.addDeployment(makeDeployment({ codeHash, chainId: 10 }));
  store.addDeployment(makeDeployment({ codeHash, chainId: 42161 }));

  assert.equal(store.deploymentsByChain(codeHash, 10).length, 1);
  assert.equal(store.deploymentsByChain(codeHash, 42161).length, 1);
  assert.equal(store.deploymentsByChain(codeHash, 999).length, 0);
  store.close();
});

test("sqlite: chainIdsByCodeHash returns distinct chains", () => {
  const store = new SqliteIndexStore({ path: tempDb() });
  const codeHash = "0xaabb";
  store.addDeployment(makeDeployment({ codeHash, chainId: 10 }));
  store.addDeployment(makeDeployment({ codeHash, chainId: 42161 }));
  store.addDeployment(makeDeployment({ codeHash, chainId: 10, address: "0x1234" + "0".repeat(36) }));

  const chains = store.chainIdsByCodeHash(codeHash);
  assert.deepEqual(chains, [10, 42161]);
  store.close();
});

test("sqlite: state returns correct counts", () => {
  const store = new SqliteIndexStore({ path: tempDb() });
  const codeHash = "0xaabb";
  store.addProof(makeProof({ codeHash, blockNumber: 50 }));
  store.addDeployment(makeDeployment({ codeHash, chainId: 10, blockNumber: 60 }));
  store.addDeployment(makeDeployment({ codeHash, chainId: 42161, blockNumber: 70 }));

  const state = store.state();
  assert.equal(state.proofCount, 1);
  assert.equal(state.deploymentCount, 2);
  assert.equal(state.chainCount, 2);
  assert.equal(state.lastBlockNumber, 70);
  store.close();
});

test("sqlite: data persists across instances", () => {
  const path = tempDb();

  const store1 = new SqliteIndexStore({ path });
  const proof = makeProof({ blockNumber: 42 });
  store1.addProof(proof);
  store1.close();

  const store2 = new SqliteIndexStore({ path });
  const fetched = store2.proofByHash(proof.proofHash);
  assert.ok(fetched);
  assert.equal(fetched.proofHash, proof.proofHash);
  assert.equal(store2.lastBlockNumber, 42);
  store2.close();
});
