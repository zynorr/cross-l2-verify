import type { Request, Response } from "express";

export type WebhookEvent = "proof.submitted" | "deployment.registered";

export interface WebhookSubscription {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  createdAt: number;
}

export interface WebhookRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

interface WebhookPayload {
  event: WebhookEvent;
  timestamp: number;
  data: unknown;
}

export interface WebhookDeliveryResult {
  subscriptionId: string;
  url: string;
  success: boolean;
  attempts: number;
  lastStatus?: number;
  error?: string;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;

export class WebhookManager {
  private _subscriptions = new Map<string, WebhookSubscription>();
  private _counter = 0;
  private readonly _retryOptions: Required<WebhookRetryOptions>;

  constructor(retryOptions?: WebhookRetryOptions) {
    this._retryOptions = {
      maxRetries: retryOptions?.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseDelayMs: retryOptions?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: retryOptions?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    };
  }

  subscribe(url: string, events: WebhookEvent[], secret?: string): WebhookSubscription {
    const id = `wh_${Date.now()}_${++this._counter}`;
    const sub: WebhookSubscription = { id, url, events, secret, createdAt: Date.now() };
    this._subscriptions.set(id, sub);
    return sub;
  }

  unsubscribe(id: string): boolean {
    return this._subscriptions.delete(id);
  }

  list(): WebhookSubscription[] {
    return [...this._subscriptions.values()];
  }

  async dispatch(event: WebhookEvent, data: unknown): Promise<WebhookDeliveryResult[]> {
    const payload: WebhookPayload = { event, timestamp: Date.now(), data };
    const body = JSON.stringify(payload);

    const targets = [...this._subscriptions.values()].filter((s) =>
      s.events.includes(event),
    );

    const results = await Promise.all(
      targets.map((sub) => this._deliverWithRetry(sub, body)),
    );

    return results;
  }

  private async _deliverWithRetry(
    sub: WebhookSubscription,
    body: string,
  ): Promise<WebhookDeliveryResult> {
    const { maxRetries, baseDelayMs, maxDelayMs } = this._retryOptions;
    let lastStatus: number | undefined;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        const jitter = delay * 0.2 * Math.random();
        await sleep(delay + jitter);
      }

      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (sub.secret) {
          headers["X-Webhook-Signature"] = await hmacSign(sub.secret, body);
        }

        const response = await fetch(sub.url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });

        lastStatus = response.status;

        if (response.ok) {
          return {
            subscriptionId: sub.id,
            url: sub.url,
            success: true,
            attempts: attempt + 1,
            lastStatus,
          };
        }

        // Don't retry 4xx (client errors) except 429 (rate limited)
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          lastError = `HTTP ${response.status}`;
          break;
        }

        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      subscriptionId: sub.id,
      url: sub.url,
      success: false,
      attempts: maxRetries + 1,
      lastStatus,
      error: lastError,
    };
  }
}

async function hmacSign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerWebhookRoutes(
  app: { post: Function; get: Function; delete: Function },
  manager: WebhookManager,
): void {
  app.post("/webhooks", (request: Request, response: Response) => {
    const { url, events, secret } = request.body as {
      url?: string;
      events?: WebhookEvent[];
      secret?: string;
    };

    if (!url || !events?.length) {
      response.status(400).json({ error: "url and events[] are required" });
      return;
    }

    const valid: WebhookEvent[] = ["proof.submitted", "deployment.registered"];
    const invalid = events.filter((e) => !valid.includes(e));
    if (invalid.length) {
      response.status(400).json({ error: `Invalid events: ${invalid.join(", ")}` });
      return;
    }

    const sub = manager.subscribe(url, events, secret);
    response.status(201).json(sub);
  });

  app.get("/webhooks", (_request: Request, response: Response) => {
    response.json(manager.list());
  });

  app.delete("/webhooks/:id", (request: Request, response: Response) => {
    const id = typeof request.params.id === "string" ? request.params.id : (request.params.id as string[])[0];
    const removed = manager.unsubscribe(id);
    response.json({ removed });
  });
}
