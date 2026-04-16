import type { Request, Response, NextFunction } from "express";

export function cors(allowedOrigins?: string[]) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.headers.origin;

    if (!allowedOrigins || allowedOrigins.includes("*")) {
      response.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && allowedOrigins.includes(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }

    response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Max-Age", "86400");

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    next();
  };
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
}

export function rateLimit(options: RateLimitOptions) {
  const { windowMs, maxRequests } = options;
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Periodic cleanup to prevent memory leak.
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  return (request: Request, response: Response, next: NextFunction): void => {
    const key = request.ip ?? "unknown";
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count++;

    response.setHeader("X-RateLimit-Limit", String(maxRequests));
    response.setHeader("X-RateLimit-Remaining", String(Math.max(0, maxRequests - entry.count)));
    response.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      response.setHeader("Retry-After", String(retryAfter));
      response.status(429).json({
        error: "Too many requests",
        retryAfter,
      });
      return;
    }

    next();
  };
}
