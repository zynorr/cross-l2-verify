import { fileURLToPath } from "node:url";

import { JsonRpcProvider } from "ethers";
import express, { type Express, type Request, type Response } from "express";

import {
  PinataIpfsClient,
  getProofByHash,
  lookup,
  type IpfsPinClient,
} from "@cross-l2-verify/sdk";
import {
  MemoryIndexStore,
  SqliteIndexStore,
  syncToHead,
  startLiveSync,
  type IndexStore,
} from "@cross-l2-verify/indexer";

import { CachedIpfsClient } from "./cached-ipfs.js";
import { cors, rateLimit } from "./middleware.js";
import { WebhookManager, registerWebhookRoutes } from "./webhooks.js";
import { Metrics } from "./metrics.js";

interface ResolverConfig {
  l1RpcUrl: string;
  registryAddress: string;
  ipfsGateway?: string;
  chainRpcUrls: Map<number, string>;
  ipfsCacheSize?: number;
  enableIndexer?: boolean;
  indexerFromBlock?: number;
  indexerBatchSize?: number;
  corsOrigins?: string[];
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  sqlitePath?: string;
}

export function createResolverApp(config: ResolverConfig): Express {
  const app = express();
  app.set("json replacer", (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

  app.use(cors(config.corsOrigins ?? ["*"]));
  app.use(rateLimit({
    windowMs: config.rateLimitWindowMs ?? 60_000,
    maxRequests: config.rateLimitMax ?? 100,
  }));
  app.use(express.json());

  const metrics = new Metrics();
  app.use(metrics.middleware());

  const registryRunner = new JsonRpcProvider(config.l1RpcUrl);
  const rawIpfsClient = new PinataIpfsClient({ gatewayUrl: config.ipfsGateway });
  const ipfsClient: IpfsPinClient = new CachedIpfsClient(rawIpfsClient, config.ipfsCacheSize ?? 500);
  const webhooks = new WebhookManager();

  const indexStore: IndexStore = config.sqlitePath
    ? new SqliteIndexStore({ path: config.sqlitePath })
    : new MemoryIndexStore();

  if (config.sqlitePath) {
    console.log(`Indexer: using SQLite at ${config.sqlitePath}`);
  }

  // SSE client broadcaster
  const sseClients = new Set<Response>();
  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch { /* client gone */ }
    }
  };

  if (config.enableIndexer !== false) {
    syncToHead({
      provider: registryRunner,
      registryAddress: config.registryAddress,
      store: indexStore,
      fromBlock: config.indexerFromBlock,
      batchSize: config.indexerBatchSize,
    }).then((count) => {
      console.log(`Indexer: synced ${count} events to head`);

      startLiveSync({
        provider: registryRunner,
        registryAddress: config.registryAddress,
        store: indexStore,
        pollIntervalMs: 12_000,
        onProof: (proof) => broadcast("proof", proof),
        onDeployment: (deployment) => broadcast("deployment", deployment),
      });
    }).catch((error) => {
      console.error("Indexer sync failed, falling back to on-chain reads:", error);
    });
  }

  // --- Routes ---

  app.get("/", (_request: Request, response: Response) => {
    response.json({
      service: "cross-l2-verify-resolver",
      version: "0.4.0",
      endpoints: [
        "/health",
        "/codehash/:codeHash",
        "/codehash/:codeHash/deployments",
        "/codehash/:codeHash/chains",
        "/chains/:chainId/addresses/:address",
        "/proofs/:proofHash",
        "/indexer/status",
        "/events",
        "/webhooks",
      ],
    });
  });

  app.get("/health", (_request: Request, response: Response) => {
    response.json({ status: "ok" });
  });

  app.get("/metrics", (_request: Request, response: Response) => {
    response.setHeader("Content-Type", "text/plain; version=0.0.4");
    response.send(metrics.toPrometheus());
  });

  app.get("/indexer/status", (_request: Request, response: Response) => {
    response.json(indexStore.state());
  });

  registerWebhookRoutes(app, webhooks);

  app.get("/codehash/:codeHash/deployments", (request: Request, response: Response) => {
    const codeHash = singlePathParam(request.params.codeHash);
    const chainId = singleQueryValue(request, "chainId");
    const { limit, offset } = parsePagination(request);

    const allDeployments = chainId
      ? indexStore.deploymentsByChain(codeHash, parsePositiveInteger(chainId))
      : indexStore.deploymentsByCodeHash(codeHash);

    const total = allDeployments.length;
    const deployments = allDeployments.slice(offset, offset + limit);

    response.json({ codeHash, deployments, total, limit, offset });
  });

  app.get("/codehash/:codeHash/chains", (request: Request, response: Response) => {
    const codeHash = singlePathParam(request.params.codeHash);
    const chains = indexStore.chainIdsByCodeHash(codeHash);

    response.json({ codeHash, chains });
  });

  app.get("/codehash/:codeHash", asyncHandler(async (request, response) => {
    const result = await lookup({
      kind: "codeHash",
      codeHash: singlePathParam(request.params.codeHash) as `0x${string}`,
      registryAddress: config.registryAddress,
      registryRunner,
      ipfsClient,
    });

    response.json(result);
  }));

  app.get(
    "/chains/:chainId/addresses/:address",
    asyncHandler(async (request, response) => {
      const chainId = parsePositiveInteger(singlePathParam(request.params.chainId));
      const targetRpc =
        singleQueryValue(request, "rpc") ?? config.chainRpcUrls.get(chainId);

      if (!targetRpc) {
        response.status(400).json({
          error: `Missing RPC URL for chain ${chainId}. Set CHAIN_RPC_URLS or pass ?rpc=<url>.`,
        });
        return;
      }

      const result = await lookup({
        kind: "address",
        targetProvider: new JsonRpcProvider(targetRpc),
        targetAddress: singlePathParam(request.params.address),
        targetChainId: chainId,
        registryAddress: config.registryAddress,
        registryRunner,
        ipfsClient,
      });

      response.json(result);
    }),
  );

  app.get("/proofs/:proofHash", asyncHandler(async (request, response) => {
    const result = await getProofByHash({
      proofHash: singlePathParam(request.params.proofHash) as `0x${string}`,
      registryAddress: config.registryAddress,
      registryRunner,
      ipfsClient,
    });

    response.json(result);
  }));

  // --- SSE event stream ---
  app.get("/events", (request: Request, response: Response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    sseClients.add(response);

    // Send initial status
    const state = indexStore.state();
    response.write(`event: status\ndata: ${JSON.stringify(state)}\n\n`);

    // Poll for status changes every 12s
    let lastBlock = state.lastBlockNumber;
    const interval = setInterval(() => {
      const current = indexStore.state();
      if (current.lastBlockNumber !== lastBlock) {
        lastBlock = current.lastBlockNumber;
        response.write(`event: status\ndata: ${JSON.stringify(current)}\n\n`);
      }
    }, 12_000);

    request.on("close", () => {
      clearInterval(interval);
      sseClients.delete(response);
    });
  });

  app.use((error: unknown, _request: Request, response: Response, _next: () => void) => {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = readConfigFromEnvironment();
  const app = createResolverApp(config);
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);

  app.listen(port, () => {
    console.log(`Resolver API listening on http://127.0.0.1:${port}`);
  });
}

function asyncHandler(
  handler: (request: Request, response: Response) => Promise<void>,
) {
  return (request: Request, response: Response, next: (error?: unknown) => void): void => {
    handler(request, response).catch(next);
  };
}

function readConfigFromEnvironment(): ResolverConfig {
  const fromBlock = process.env.FROM_BLOCK ? Number.parseInt(process.env.FROM_BLOCK, 10) : undefined;
  const batchSize = process.env.BATCH_SIZE ? Number.parseInt(process.env.BATCH_SIZE, 10) : undefined;

  return {
    l1RpcUrl: requiredString(process.env.L1_RPC_URL, "L1_RPC_URL is required"),
    registryAddress: requiredString(process.env.REGISTRY_ADDRESS, "REGISTRY_ADDRESS is required"),
    ipfsGateway: process.env.IPFS_GATEWAY,
    chainRpcUrls: parseChainRpcUrls(process.env.CHAIN_RPC_URLS),
    indexerFromBlock: fromBlock,
    indexerBatchSize: batchSize,
    sqlitePath: process.env.SQLITE_PATH,
  };
}

function parseChainRpcUrls(value: string | undefined): Map<number, string> {
  if (!value) {
    return new Map();
  }

  return new Map(
    value.split(",").filter(Boolean).map((entry) => {
      const [chainId, rpcUrl] = entry.split("=");
      return [parsePositiveInteger(chainId), rpcUrl];
    }),
  );
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }

  return parsed;
}

function parsePagination(request: Request): { limit: number; offset: number } {
  const rawLimit = singleQueryValue(request, "limit");
  const rawOffset = singleQueryValue(request, "offset");

  let limit = rawLimit ? Number.parseInt(rawLimit, 10) : 100;
  let offset = rawOffset ? Number.parseInt(rawOffset, 10) : 0;

  if (!Number.isFinite(limit) || limit < 1) limit = 100;
  if (limit > 1000) limit = 1000;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  return { limit, offset };
}

function requiredString(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function singleQueryValue(request: Request, key: string): string | undefined {
  const value = request.query[key];
  return typeof value === "string" ? value : undefined;
}

function singlePathParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}
