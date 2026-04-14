import test from "node:test";
import assert from "node:assert/strict";

import { MemoryIndexStore } from "./store.js";
import type { IndexedDeployment, IndexedProof } from "./types.js";

function makeProof(overrides: Partial<IndexedProof> = {}): IndexedProof {
  return {
    proofHash: "0x" + "a".repeat(64),
    codeHash: "0x" + "b".repeat(64),
    sourceHash: "0x" + "c".repeat(64),
    compilerVersion: "0.8.26",
    ipfsCid: "bafytest",
    submitter: "0x" + "1".repeat(40),
    blockNumber: 100,
    transactionHash: "0x" + "d".repeat(64),
    logIndex: 0,
    ...overrides,
  };
}

function makeDeployment(overrides: Partial<IndexedDeployment> = {}): IndexedDeployment {
  return {
    codeHash: "0x" + "b".repeat(64),
    chainId: 10,
    address: "0x" + "2".repeat(40),
    submitter: "0x" + "1".repeat(40),
    blockNumber: 101,
    transactionHash: "0x" + "e".repeat(64),
    logIndex: 0,
    ...overrides,
  };
}

test("adds and retrieves proofs by code hash", () => {
  const store = new MemoryIndexStore();
  const proof = makeProof();

  store.addProof(proof);

  const results = store.proofsByCodeHash(proof.codeHash);
  assert.equal(results.length, 1);
  assert.equal(results[0].proofHash, proof.proofHash);
});

test("deduplicates proofs by proofHash", () => {
  const store = new MemoryIndexStore();
  const proof = makeProof();

  store.addProof(proof);
  store.addProof(proof);

  assert.equal(store.proofsByCodeHash(proof.codeHash).length, 1);
});

test("retrieves proof by hash", () => {
  const store = new MemoryIndexStore();
  const proof = makeProof();

  store.addProof(proof);

  assert.deepEqual(store.proofByHash(proof.proofHash), proof);
  assert.equal(store.proofByHash("0x" + "f".repeat(64)), undefined);
});

test("adds and retrieves deployments", () => {
  const store = new MemoryIndexStore();
  const deployment = makeDeployment();

  store.addDeployment(deployment);

  const results = store.deploymentsByCodeHash(deployment.codeHash);
  assert.equal(results.length, 1);
  assert.equal(results[0].chainId, 10);
});

test("filters deployments by chain", () => {
  const store = new MemoryIndexStore();
  const d1 = makeDeployment({ chainId: 10, address: "0x" + "2".repeat(40) });
  const d2 = makeDeployment({ chainId: 42161, address: "0x" + "3".repeat(40) });

  store.addDeployment(d1);
  store.addDeployment(d2);

  assert.equal(store.deploymentsByChain(d1.codeHash, 10).length, 1);
  assert.equal(store.deploymentsByChain(d1.codeHash, 42161).length, 1);
  assert.equal(store.deploymentsByChain(d1.codeHash, 999).length, 0);
});

test("deduplicates deployments", () => {
  const store = new MemoryIndexStore();
  const deployment = makeDeployment();

  store.addDeployment(deployment);
  store.addDeployment(deployment);

  assert.equal(store.deploymentsByCodeHash(deployment.codeHash).length, 1);
});

test("returns unique chain ids", () => {
  const store = new MemoryIndexStore();
  store.addDeployment(makeDeployment({ chainId: 10, address: "0x" + "2".repeat(40) }));
  store.addDeployment(makeDeployment({ chainId: 42161, address: "0x" + "3".repeat(40) }));
  store.addDeployment(makeDeployment({ chainId: 10, address: "0x" + "4".repeat(40) }));

  const codeHash = "0x" + "b".repeat(64);
  const chains = store.chainIdsByCodeHash(codeHash).sort((a, b) => a - b);

  assert.deepEqual(chains, [10, 42161]);
});

test("state reflects counts", () => {
  const store = new MemoryIndexStore();

  store.addProof(makeProof());
  store.addDeployment(makeDeployment({ chainId: 10, address: "0x" + "2".repeat(40) }));
  store.addDeployment(makeDeployment({ chainId: 42161, address: "0x" + "3".repeat(40) }));

  const state = store.state();
  assert.equal(state.proofCount, 1);
  assert.equal(state.deploymentCount, 2);
  assert.equal(state.lastBlockNumber, 101);
});
