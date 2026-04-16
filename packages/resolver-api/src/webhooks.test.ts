import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { WebhookManager } from "./webhooks.js";

function createTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to bind");
      resolve({
        url: `http://127.0.0.1:${addr.port}/hook`,
        close: () => server.close(),
      });
    });
  });
}

test("webhook: subscribe and list", () => {
  const mgr = new WebhookManager();
  const sub = mgr.subscribe("https://example.com/hook", ["proof.submitted"]);
  assert.ok(sub.id.startsWith("wh_"));
  assert.equal(sub.url, "https://example.com/hook");
  assert.deepEqual(sub.events, ["proof.submitted"]);
  assert.equal(mgr.list().length, 1);
});

test("webhook: unsubscribe", () => {
  const mgr = new WebhookManager();
  const sub = mgr.subscribe("https://example.com/hook", ["proof.submitted"]);
  assert.equal(mgr.unsubscribe(sub.id), true);
  assert.equal(mgr.list().length, 0);
  assert.equal(mgr.unsubscribe("nonexistent"), false);
});

test("webhook: dispatch delivers to matching subscribers", async () => {
  const received: string[] = [];
  const srv = await createTestServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200);
      res.end();
    });
  });

  try {
    const mgr = new WebhookManager({ maxRetries: 0 });
    mgr.subscribe(srv.url, ["proof.submitted"]);
    mgr.subscribe(srv.url, ["deployment.registered"]);

    const results = await mgr.dispatch("proof.submitted", { hash: "0x123" });
    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
    assert.equal(results[0].attempts, 1);
    assert.equal(received.length, 1);

    const payload = JSON.parse(received[0]);
    assert.equal(payload.event, "proof.submitted");
    assert.equal(payload.data.hash, "0x123");
  } finally {
    srv.close();
  }
});

test("webhook: dispatch includes HMAC signature when secret is set", async () => {
  let signatureHeader: string | undefined;
  const srv = await createTestServer((req, res) => {
    signatureHeader = req.headers["x-webhook-signature"] as string;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200);
      res.end();
    });
  });

  try {
    const mgr = new WebhookManager({ maxRetries: 0 });
    mgr.subscribe(srv.url, ["proof.submitted"], "my-secret");

    await mgr.dispatch("proof.submitted", { test: true });
    assert.ok(signatureHeader, "signature header should be present");
    assert.match(signatureHeader!, /^[0-9a-f]{64}$/);
  } finally {
    srv.close();
  }
});

test("webhook: retries on 5xx with exponential backoff", async () => {
  let callCount = 0;
  const srv = await createTestServer((_req, res) => {
    callCount++;
    let body = "";
    _req.on("data", (c) => (body += c));
    _req.on("end", () => {
      if (callCount < 3) {
        res.writeHead(500);
      } else {
        res.writeHead(200);
      }
      res.end();
    });
  });

  try {
    const mgr = new WebhookManager({ maxRetries: 3, baseDelayMs: 50, maxDelayMs: 200 });
    mgr.subscribe(srv.url, ["proof.submitted"]);

    const results = await mgr.dispatch("proof.submitted", {});
    assert.equal(results.length, 1);
    assert.equal(results[0].success, true);
    assert.equal(results[0].attempts, 3);
    assert.equal(callCount, 3);
  } finally {
    srv.close();
  }
});

test("webhook: does not retry on 4xx (except 429)", async () => {
  let callCount = 0;
  const srv = await createTestServer((_req, res) => {
    callCount++;
    let body = "";
    _req.on("data", (c) => (body += c));
    _req.on("end", () => {
      res.writeHead(400);
      res.end();
    });
  });

  try {
    const mgr = new WebhookManager({ maxRetries: 3, baseDelayMs: 50 });
    mgr.subscribe(srv.url, ["proof.submitted"]);

    const results = await mgr.dispatch("proof.submitted", {});
    assert.equal(results.length, 1);
    assert.equal(results[0].success, false);
    assert.equal(callCount, 1, "should not retry 4xx");
    assert.equal(results[0].error, "HTTP 400");
  } finally {
    srv.close();
  }
});

test("webhook: returns failure after max retries exhausted", async () => {
  const srv = await createTestServer((_req, res) => {
    let body = "";
    _req.on("data", (c) => (body += c));
    _req.on("end", () => {
      res.writeHead(503);
      res.end();
    });
  });

  try {
    const mgr = new WebhookManager({ maxRetries: 2, baseDelayMs: 50 });
    mgr.subscribe(srv.url, ["proof.submitted"]);

    const results = await mgr.dispatch("proof.submitted", {});
    assert.equal(results.length, 1);
    assert.equal(results[0].success, false);
    assert.equal(results[0].attempts, 3); // initial + 2 retries
    assert.equal(results[0].lastStatus, 503);
  } finally {
    srv.close();
  }
});
