# syntax=docker/dockerfile:1

FROM node:26.13.0-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@12.17.0 --allow-scripts=pnpm
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
RUN pnpm install --frozen-lockfile --filter @ss-deals/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
RUN pnpm --filter @ss-deals/web build

FROM node:26.13.0-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/web/server.js"]
