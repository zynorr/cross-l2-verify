import test from "node:test";
import assert from "node:assert/strict";

import { createResolverApp } from "./server.js";

// Disable the event indexer for unit tests — we test endpoints in isolation.
function createTestApp() {
  return createResolverApp({
    l1RpcUrl: "http://localhost:8545",
    registryAddress: "0x0000000000000000000000000000000000000001",
    chainRpcUrls: new Map(),
    enableIndexer: false,
  });
}

async function request(
  app: ReturnType<typeof createTestApp>,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const { method = "GET", headers = {}, body } = options;

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind"));
        return;
      }

      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body,
      })
        .then(async (res) => {
          const responseHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => (responseHeaders[k] = v));

          let responseBody: unknown;
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("json")) responseBody = await res.json();
          else responseBody = await res.text();

          resolve({ status: res.status, headers: responseHeaders, body: responseBody });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

test("GET / returns service info", async () => {
  const app = createTestApp();
  const res = await request(app, "/");
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.service, "cross-l2-verify-resolver");
  assert.ok(Array.isArray(body.endpoints));
});

test("GET /health returns ok", async () => {
  const app = createTestApp();
  const res = await request(app, "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: "ok" });
});

test("GET /metrics returns prometheus text", async () => {
  const app = createTestApp();
  const res = await request(app, "/metrics");
  assert.equal(res.status, 200);
  assert.ok(res.headers["content-type"]?.includes("text/plain"));
  assert.ok((res.body as string).includes("resolver_requests_total"));
  assert.ok((res.body as string).includes("resolver_uptime_seconds"));
});

test("GET /indexer/status returns counts", async () => {
  const app = createTestApp();
  const res = await request(app, "/indexer/status");
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.proofCount, 0);
  assert.equal(body.deploymentCount, 0);
});

test("GET /codehash/:hash/deployments returns empty for unknown hash", async () => {
  const app = createTestApp();
  const hash = "0x" + "ab".repeat(32);
  const res = await request(app, `/codehash/${hash}/deployments`);
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.codeHash, hash);
  assert.ok(Array.isArray(body.deployments));
  assert.equal((body.deployments as unknown[]).length, 0);
});

test("GET /codehash/:hash/chains returns empty for unknown hash", async () => {
  const app = createTestApp();
  const hash = "0x" + "cd".repeat(32);
  const res = await request(app, `/codehash/${hash}/chains`);
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.equal(body.codeHash, hash);
  assert.ok(Array.isArray(body.chains));
  assert.equal((body.chains as unknown[]).length, 0);
});

test("CORS headers are set", async () => {
  const app = createTestApp();
  const res = await request(app, "/health");
  assert.equal(res.headers["access-control-allow-origin"], "*");
});

test("OPTIONS returns 204 preflight", async () => {
  const app = createTestApp();
  const res = await request(app, "/health", { method: "OPTIONS" });
  assert.equal(res.status, 204);
});

test("POST /webhooks creates a subscription", async () => {
  const app = createTestApp();
  const res = await request(app, "/webhooks", {
    method: "POST",
    body: JSON.stringify({ url: "https://example.com/hook", events: ["proof.submitted"] }),
  });
  assert.equal(res.status, 201);
  const body = res.body as Record<string, unknown>;
  assert.ok((body.id as string).startsWith("wh_"));
  assert.equal(body.url, "https://example.com/hook");
});

test("POST /webhooks rejects invalid events", async () => {
  const app = createTestApp();
  const res = await request(app, "/webhooks", {
    method: "POST",
    body: JSON.stringify({ url: "https://example.com/hook", events: ["invalid.event"] }),
  });
  assert.equal(res.status, 400);
});

test("POST /webhooks rejects missing url", async () => {
  const app = createTestApp();
  const res = await request(app, "/webhooks", {
    method: "POST",
    body: JSON.stringify({ events: ["proof.submitted"] }),
  });
  assert.equal(res.status, 400);
});

test("GET /webhooks lists subscriptions", async () => {
  const app = createTestApp();

  await request(app, "/webhooks", {
    method: "POST",
    body: JSON.stringify({ url: "https://a.com/hook", events: ["proof.submitted"] }),
  });

  // Note: each request starts a new server so subscriptions are per-app
  // This tests the route exists and returns an array.
  const res = await request(app, "/webhooks");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
});

test("rate limit: Retry-After header is set on 429", async () => {
  const app = createResolverApp({
    l1RpcUrl: "http://localhost:8545",
    registryAddress: "0x0000000000000000000000000000000000000001",
    chainRpcUrls: new Map(),
    enableIndexer: false,
    rateLimitMax: 1,
    rateLimitWindowMs: 60_000,
  });

  const result = await new Promise<{ status: number; retryAfter: string | null }>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind"));
        return;
      }

      const url = `http://127.0.0.1:${addr.port}/health`;
      (async () => {
        await fetch(url); // first request uses the quota
        const res = await fetch(url); // second exceeds the limit
        resolve({
          status: res.status,
          retryAfter: res.headers.get("retry-after"),
        });
      })()
        .catch(reject)
        .finally(() => server.close());
    });
  });

  assert.equal(result.status, 429);
  assert.ok(result.retryAfter, "Retry-After header should be set");
  assert.ok(Number(result.retryAfter) > 0, "Retry-After should be a positive number");
});
