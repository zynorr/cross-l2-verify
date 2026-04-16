FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Install deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/tooling/package.json packages/tooling/
COPY packages/hardhat/package.json packages/hardhat/
COPY packages/foundry/package.json packages/foundry/
COPY packages/indexer/package.json packages/indexer/
COPY packages/explorer-client/package.json packages/explorer-client/
COPY packages/cli/package.json packages/cli/
COPY packages/resolver-api/package.json packages/resolver-api/
COPY packages/integration/package.json packages/integration/

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.base.json ./
COPY packages/ packages/
RUN pnpm build

# --- Resolver API ---
FROM node:20-slim AS resolver
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

COPY --from=base /app/ /app/

ENV PORT=3000
EXPOSE 3000

# Persistent SQLite storage
VOLUME /data
ENV SQLITE_PATH=/data/index.db

CMD ["node", "packages/resolver-api/dist/server.js"]
