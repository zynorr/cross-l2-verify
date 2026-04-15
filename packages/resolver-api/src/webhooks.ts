import type { Request, Response } from "express";

export type WebhookEvent = "proof.submitted" | "deployment.registered";

export interface WebhookSubscription {
  id: string;
  url: string;
  events: WebhookEvent[];
  secret?: string;
  createdAt: number;
}

interface WebhookPayload {
  event: WebhookEvent;
  timestamp: number;
  data: unknown;
}

export class WebhookManager {
  private _subscriptions = new Map<string, WebhookSubscription>();
  private _counter = 0;

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

  async dispatch(event: WebhookEvent, data: unknown): Promise<void> {
    const payload: WebhookPayload = { event, timestamp: Date.now(), data };
    const body = JSON.stringify(payload);

    const targets = [...this._subscriptions.values()].filter((s) =>
      s.events.includes(event),
    );

    await Promise.allSettled(
      targets.map(async (sub) => {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (sub.secret) {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey(
              "raw",
              encoder.encode(sub.secret),
              { name: "HMAC", hash: "SHA-256" },
              false,
              ["sign"],
            );
            const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
            headers["X-Webhook-Signature"] = Array.from(new Uint8Array(signature))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
          }

          await fetch(sub.url, { method: "POST", headers, body });
        } catch {
          // Fire-and-forget — don't block the caller.
        }
      }),
    );
  }
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
