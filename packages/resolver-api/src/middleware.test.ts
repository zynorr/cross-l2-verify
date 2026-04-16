import test from "node:test";
import assert from "node:assert/strict";

import express from "express";

import { cors, rateLimit } from "./middleware.js";

// ---------------------------------------------------------------------------
// Helpers — lightweight supertest-style requests against an Express app.
// ---------------------------------------------------------------------------

async function request(
  app: express.Express,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const { method = "GET", headers = {} } = options;

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind"));
        return;
      }

      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url, { method, headers })
        .then(async (res) => {
          const responseHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            responseHeaders[k] = v;
          });

          let body: unknown;
          const ct = res.headers.get("content-type") ?? "";
          if (ct.includes("json")) {
            body = await res.json();
          } else {
            body = await res.text();
          }

          resolve({ status: res.status, headers: responseHeaders, body });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

// ---------------------------------------------------------------------------
// CORS middleware tests
// ---------------------------------------------------------------------------

test("cors: wildcard origin sets Access-Control-Allow-Origin to *", async () => {
  const app = express();
  app.use(cors(["*"]));
  app.get("/", (_req, res) => res.json({ ok: true }));

  const res = await request(app, "/");
  assert.equal(res.headers["access-control-allow-origin"], "*");
});

test("cors: echoes allowed origin back when matched", async () => {
  const app = express();
  app.use(cors(["https://example.com"]));
  app.get("/", (_req, res) => res.json({ ok: true }));

  const res = await request(app, "/", {
    headers: { Origin: "https://example.com" },
  });

  assert.equal(res.headers["access-control-allow-origin"], "https://example.com");
  assert.equal(res.headers["vary"], "Origin");
});

test("cors: does not set allow-origin for unmatched origin", async () => {
  const app = express();
  app.use(cors(["https://allowed.com"]));
  app.get("/", (_req, res) => res.json({ ok: true }));

  const res = await request(app, "/", {
    headers: { Origin: "https://evil.com" },
  });

  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("cors: OPTIONS preflight returns 204", async () => {
  const app = express();
  app.use(cors(["*"]));
  app.get("/", (_req, res) => res.json({ ok: true }));

  const res = await request(app, "/", { method: "OPTIONS" });
  assert.equal(res.status, 204);
});

// ---------------------------------------------------------------------------
// Rate limit middleware tests
// ---------------------------------------------------------------------------

test("rate limit: allows requests within the limit", async () => {
  const app = express();
  app.set("trust proxy", true);
  app.use(rateLimit({ windowMs: 60_000, maxRequests: 5 }));
  app.get("/", (_req, res) => res.json({ ok: true }));

  const res = await request(app, "/");
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-ratelimit-limit"], "5");
});

test("rate limit: returns 429 after exceeding maxRequests", async () => {
  const app = express();
  app.set("trust proxy", true);
  app.use(rateLimit({ windowMs: 60_000, maxRequests: 2 }));
  app.get("/", (_req, res) => res.json({ ok: true }));

  // Use three sequential requests on the same server to ensure the same IP
  // bucket is hit.
  const result = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind"));
        return;
      }

      const url = `http://127.0.0.1:${addr.port}/`;

      (async () => {
        // First two requests should succeed (count 1 and 2 are within limit).
        await fetch(url);
        await fetch(url);
        // Third request should exceed the limit.
        const res = await fetch(url);
        const body = await res.json();
        resolve({ status: res.status, body });
      })()
        .catch(reject)
        .finally(() => server.close());
    });
  });

  assert.equal(result.status, 429);
  assert.equal((result.body as Record<string, unknown>).error, "Too many requests");
});

test("rate limit: returns Retry-After header on 429", async () => {
  const app = express();
  app.set("trust proxy", true);
  app.use(rateLimit({ windowMs: 60_000, maxRequests: 1 }));
  app.get("/", (_req, res) => res.json({ ok: true }));

  const result = await new Promise<{ status: number; retryAfter: string | null }>((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind"));
        return;
      }

      const url = `http://127.0.0.1:${addr.port}/`;
      (async () => {
        await fetch(url); // uses the single allowed request
        const res = await fetch(url); // exceeds limit
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
  assert.ok(result.retryAfter, "Retry-After header should be present");
  assert.ok(Number(result.retryAfter) > 0);
});

test("rate limit: sets X-RateLimit-Remaining header", async () => {
  const app = express();
  app.set("trust proxy", true);
  app.use(rateLimit({ windowMs: 60_000, maxRequests: 10 }));
  app.get("/", (_req, res) => res.json({ ok: true }));

  const res = await request(app, "/");
  assert.equal(res.headers["x-ratelimit-remaining"], "9");
});
