# syntax=docker/dockerfile:1

FROM node:26.13.0-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.17.0 --allow-scripts=pnpm
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/quickpost/package.json ./apps/quickpost/package.json
COPY packages/core/package.json ./packages/core/package.json
RUN pnpm install --frozen-lockfile --filter @ss-deals/quickpost...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core/tsconfig.json ./packages/core/tsconfig.json
COPY packages/core/src ./packages/core/src
COPY apps/quickpost/tsconfig.json ./apps/quickpost/tsconfig.json
COPY apps/quickpost/src ./apps/quickpost/src
RUN pnpm --filter @ss-deals/core build \
    && pnpm --filter @ss-deals/quickpost build \
    && pnpm --filter @ss-deals/quickpost deploy --prod /out \
    && rm -rf /out/dist \
    && cp -R apps/quickpost/dist /out/dist

FROM node:26.13.0-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
