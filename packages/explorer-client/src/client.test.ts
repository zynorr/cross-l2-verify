import test from "node:test";
import assert from "node:assert/strict";

import { ResolverClient, ResolverError } from "./index.js";

function mockFetch(responses: Record<string, unknown>) {
  return async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    const body = responses[path];

    if (body === undefined) {
      return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) } as Response;
    }

    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
  };
}

test("health returns status", async () => {
  const client = new ResolverClient({
    baseUrl: "http://localhost:3000",
    fetchFn: mockFetch({ "/health": { status: "ok" } }),
  });

  const result = await client.health();
  assert.equal(result.status, "ok");
});

test("lookupByCodeHash calls correct endpoint", async () => {
  const hash = "0x" + "a".repeat(64);
  const mockResponse = {
    codeHash: hash,
    proofs: [{ proofHash: "0x1", codeHash: hash, sourceHash: "0x2", compilerVersion: "0.8.26", ipfsCid: "bafy" }],
    chainIds: [10],
    deploymentsByChain: { "10": ["0xdead"] },
  };

  const client = new ResolverClient({
    baseUrl: "http://localhost:3000",
    fetchFn: mockFetch({ [`/codehash/${hash}`]: mockResponse }),
  });

  const result = await client.lookupByCodeHash(hash);
  assert.equal(result.proofs.length, 1);
  assert.deepEqual(result.chainIds, [10]);
});

test("isVerified returns true when proofs exist", async () => {
  const client = new ResolverClient({
    baseUrl: "http://localhost:3000",
    fetchFn: mockFetch({
      "/chains/10/addresses/0xdead": {
        codeHash: "0x1",
        proofs: [{ proofHash: "0x1" }],
        chainIds: [10],
        deploymentsByChain: {},
      },
    }),
  });

  assert.equal(await client.isVerified(10, "0xdead"), true);
});

test("isVerified returns false when no proofs", async () => {
  const client = new ResolverClient({
    baseUrl: "http://localhost:3000",
    fetchFn: mockFetch({
      "/chains/10/addresses/0xdead": {
        codeHash: "0x1",
        proofs: [],
        chainIds: [],
        deploymentsByChain: {},
      },
    }),
  });

  assert.equal(await client.isVerified(10, "0xdead"), false);
});

test("isVerified returns false on error", async () => {
  const client = new ResolverClient({
    baseUrl: "http://localhost:3000",
    fetchFn: mockFetch({}),
  });

  assert.equal(await client.isVerified(10, "0xdead"), false);
});

test("throws ResolverError on non-ok response", async () => {
  const client = new ResolverClient({
    baseUrl: "http://localhost:3000",
    fetchFn: mockFetch({}),
  });

  await assert.rejects(
    () => client.getProof("0xbad"),
    (error: unknown) => {
      assert.ok(error instanceof ResolverError);
      assert.equal(error.status, 404);
      return true;
    },
  );
});

test("indexerStatus calls correct endpoint", async () => {
  const client = new ResolverClient({
    baseUrl: "http://localhost:3000",
    fetchFn: mockFetch({ "/indexer/status": { lastBlockNumber: 100, proofCount: 5, deploymentCount: 12 } }),
  });

  const status = await client.indexerStatus();
  assert.equal(status.proofCount, 5);
  assert.equal(status.deploymentCount, 12);
});
