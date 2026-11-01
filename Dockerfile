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
COPY packages/core/package.json ./packages/core/package.json
RUN pnpm install --frozen-lockfile --filter @ss-deals/server...

FROM deps AS dev
COPY tsconfig.base.json ./
COPY packages/core/tsconfig.json ./packages/core/tsconfig.json
COPY packages/core/src ./packages/core/src
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/server/src ./apps/server/src
COPY apps/server/drizzle ./apps/server/drizzle
RUN pnpm --filter @ss-deals/core build
WORKDIR /app/apps/server
USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--import", "tsx", "--watch", "src/api/main.ts"]

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/core/tsconfig.json ./packages/core/tsconfig.json
COPY packages/core/src ./packages/core/src
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/server/src ./apps/server/src
COPY apps/server/drizzle ./apps/server/drizzle
RUN pnpm --filter @ss-deals/server build \
    && pnpm --filter @ss-deals/server deploy --prod /out \
    && rm -rf /out/dist /out/drizzle \
    && cp -R apps/server/dist /out/dist \
    && cp -R apps/server/drizzle /out/drizzle

FROM node:26.13.0-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/ ./
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/api/main.js"]
