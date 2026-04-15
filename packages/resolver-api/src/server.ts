import { fileURLToPath } from "node:url";

import { JsonRpcProvider } from "ethers";
import express, { type Express, type Request, type Response } from "express";

import {
  PinataIpfsClient,
  getProofByHash,
  lookup,
  type IpfsPinClient,
} from "@cross-l2-verify/sdk";
import { MemoryIndexStore, syncToHead, startLiveSync } from "@cross-l2-verify/indexer";

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
  corsOrigins?: string[];
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
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

  const indexStore = new MemoryIndexStore();
  let liveSyncHandle: { stop: () => void } | undefined;

  if (config.enableIndexer !== false) {
    syncToHead({
      provider: registryRunner,
      registryAddress: config.registryAddress,
      store: indexStore,
    }).then((count) => {
      console.log(`Indexer: synced ${count} events to head`);

      liveSyncHandle = startLiveSync({
        provider: registryRunner,
        registryAddress: config.registryAddress,
        store: indexStore,
        pollIntervalMs: 12_000,
      });
    }).catch((error) => {
      console.error("Indexer sync failed, falling back to on-chain reads:", error);
    });
  }

  app.get("/", (_request: Request, response: Response) => {
    response.json({
      service: "cross-l2-verify-resolver",
      version: "0.3.0",
      endpoints: [
        "/health",
        "/codehash/:codeHash",
        "/codehash/:codeHash/deployments",
        "/codehash/:codeHash/chains",
        "/chains/:chainId/addresses/:address",
        "/proofs/:proofHash",
        "/indexer/status",
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

  app.get("/codehash/:codeHash/deployments", (_request: Request, response: Response) => {
    const codeHash = singlePathParam(_request.params.codeHash);
    const chainId = singleQueryValue(_request, "chainId");

    const deployments = chainId
      ? indexStore.deploymentsByChain(codeHash, parsePositiveInteger(chainId))
      : indexStore.deploymentsByCodeHash(codeHash);

    response.json({ codeHash, deployments });
  });

  app.get("/codehash/:codeHash/chains", (_request: Request, response: Response) => {
    const codeHash = singlePathParam(_request.params.codeHash);
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
  return {
    l1RpcUrl: requiredString(process.env.L1_RPC_URL, "L1_RPC_URL is required"),
    registryAddress: requiredString(process.env.REGISTRY_ADDRESS, "REGISTRY_ADDRESS is required"),
    ipfsGateway: process.env.IPFS_GATEWAY,
    chainRpcUrls: parseChainRpcUrls(process.env.CHAIN_RPC_URLS),
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
