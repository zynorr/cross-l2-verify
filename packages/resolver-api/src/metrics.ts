import type { Request, Response, NextFunction } from "express";

export class Metrics {
  private _requestCount = 0;
  private _errorCount = 0;
  private _latencySum = 0;
  private _routeHits = new Map<string, number>();
  private _statusCodes = new Map<number, number>();
  private _startTime = Date.now();

  middleware() {
    return (request: Request, response: Response, next: NextFunction): void => {
      const start = performance.now();

      response.on("finish", () => {
        this._requestCount++;
        this._latencySum += performance.now() - start;

        const status = response.statusCode;
        this._statusCodes.set(status, (this._statusCodes.get(status) ?? 0) + 1);
        if (status >= 400) this._errorCount++;

        const route = request.route?.path ?? request.path;
        this._routeHits.set(route, (this._routeHits.get(route) ?? 0) + 1);
      });

      next();
    };
  }

  toPrometheus(): string {
    const lines: string[] = [];
    const uptime = (Date.now() - this._startTime) / 1000;

    lines.push("# HELP resolver_uptime_seconds Time since server start");
    lines.push("# TYPE resolver_uptime_seconds gauge");
    lines.push(`resolver_uptime_seconds ${uptime.toFixed(1)}`);

    lines.push("# HELP resolver_requests_total Total HTTP requests");
    lines.push("# TYPE resolver_requests_total counter");
    lines.push(`resolver_requests_total ${this._requestCount}`);

    lines.push("# HELP resolver_errors_total Total HTTP 4xx/5xx responses");
    lines.push("# TYPE resolver_errors_total counter");
    lines.push(`resolver_errors_total ${this._errorCount}`);

    lines.push("# HELP resolver_avg_latency_ms Average request latency in ms");
    lines.push("# TYPE resolver_avg_latency_ms gauge");
    const avg = this._requestCount > 0 ? this._latencySum / this._requestCount : 0;
    lines.push(`resolver_avg_latency_ms ${avg.toFixed(2)}`);

    lines.push("# HELP resolver_http_status_total Requests by HTTP status code");
    lines.push("# TYPE resolver_http_status_total counter");
    for (const [code, count] of this._statusCodes) {
      lines.push(`resolver_http_status_total{code="${code}"} ${count}`);
    }

    lines.push("# HELP resolver_route_hits_total Requests by route");
    lines.push("# TYPE resolver_route_hits_total counter");
    for (const [route, count] of this._routeHits) {
      lines.push(`resolver_route_hits_total{route="${route}"} ${count}`);
    }

    return lines.join("\n") + "\n";
  }
}
