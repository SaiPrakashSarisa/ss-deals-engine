# ss-deals-engine

Foundation for a small affiliate deals platform: a TypeScript API, a worker process, and PostgreSQL. Business features are not in this tree yet.

The same images run on macOS arm64 for development and Ubuntu x86_64 for production. Official Node and Postgres images are multi-arch. Node is pinned to the active LTS, 26.13.0 (`.nvmrc` and `Dockerfile`). Postgres is pinned to major version 17.

## Prerequisites

- Node.js 26.13.0 (`nvm use` from the repo root)
- pnpm 12.17.0 (`corepack enable` then `corepack prepare pnpm@12.17.0 --activate`, or install it another way)
- Docker with Compose v2

On Ubuntu, the official Node.js 26 binary needs `libatomic1` if you run the API on the host instead of in Docker:

```bash
sudo apt-get update && sudo apt-get install -y libatomic1
```

The Docker image already includes what Node needs. You do not install libatomic inside the image yourself. The Node 26 image also omits Corepack, so the Dockerfile installs pnpm with `npm install -g pnpm@12.17.0`.

## Environment

```bash
cp .env.example .env
```

`.env` is gitignored. `.env.example` lists every variable the process reads:

| Variable               | Required          | Default                                               |
| ---------------------- | ----------------- | ----------------------------------------------------- |
| `NODE_ENV`             | no                | `development` (`production` in the base Compose file) |
| `PORT`                 | no                | `3000`                                                |
| `DATABASE_URL`         | yes               | none outside Compose                                  |
| `LOG_LEVEL`            | no                | `info`                                                |
| `TZ`                   | no                | `Asia/Kolkata`                                        |
| `TEST_DATABASE_URL`    | no                | unset; integration tests skip                         |
| `POSTGRES_PASSWORD`    | prod Compose only | dev Compose uses `ssdeals`                            |
| `COMPOSE_DATABASE_URL` | prod Compose only | dev Compose uses the internal `postgres` hostname     |

The app exits on startup when `DATABASE_URL` is missing or not a `postgres://` or `postgresql://` URL. Logs print the database host, port, and name. They do not print the user or password.

Compose publishes Postgres on `127.0.0.1:5432` only. Dev Compose hardcodes the local role `ssdeals` / `ssdeals` so a host `.env` (which points at `127.0.0.1` for `pnpm dev`) cannot override the in-network URL. That password is for a laptop. Production Compose ignores it and requires `POSTGRES_PASSWORD` and `COMPOSE_DATABASE_URL`.

## Mac development

From the repo root:

```bash
nvm use
corepack enable
corepack prepare pnpm@12.17.0 --activate
pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The dev override bind-mounts `apps/server/src` and restarts the API and worker when those files change. Dev processes run TypeScript through `tsx`, because Node's type stripping does not resolve this repo's `.js` import specifiers to `.ts` files. Production runs the compiled `dist` output. Postgres data is kept in the named volume `postgres_data`.

In another terminal:

```bash
curl -sS http://127.0.0.1:3000/health
```

A healthy response is HTTP 200:

```json
{ "status": "ok", "uptimeSeconds": 1, "db": "up" }
```

Apply the `app_meta` migration from the host (Postgres is on localhost):

```bash
pnpm db:migrate
```

Run the API on the host instead of in Docker only after Postgres is up:

```bash
pnpm dev
pnpm dev:worker
```

`pnpm dev` reads `../../.env` when that file exists. Dev Compose does not read `DATABASE_URL` from `.env`. Containers use `postgres://ssdeals:ssdeals@postgres:5432/ssdeals`.

## Ubuntu production

Use the production override. It does not mount source, and it refuses to start until `POSTGRES_PASSWORD` and `COMPOSE_DATABASE_URL` are set. Inside Compose the database host is `postgres`, not `127.0.0.1`.

```bash
export POSTGRES_PASSWORD='replace-with-a-real-password'
export COMPOSE_DATABASE_URL="postgres://ssdeals:${POSTGRES_PASSWORD}@postgres:5432/ssdeals"
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
curl -sS http://127.0.0.1:3000/health
```

Run migrations once from the API image:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm api node dist/scripts/migrate.js
```

The API listens on `127.0.0.1:3000` on the host. Put a reverse proxy in front of it if the service should be reachable beyond the machine.

## Scripts

| Script                             | What it does                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:worker`     | API or worker with watch mode                                                                     |
| `pnpm build`                       | Compile the server to `apps/server/dist`                                                          |
| `pnpm start` / `pnpm start:worker` | Run the compiled processes                                                                        |
| `pnpm test`                        | Vitest in every workspace package. Postgres integration runs only when `TEST_DATABASE_URL` is set |
| `pnpm lint`                        | ESLint and Prettier                                                                               |
| `pnpm typecheck`                   | `tsc --noEmit` in every workspace package                                                         |
| `pnpm db:generate`                 | Create a Drizzle migration. Drizzle Kit reads `src/db/schema/index.ts`                            |
| `pnpm db:migrate`                  | Apply migrations                                                                                  |

## Tests

```bash
pnpm test
```

Without `TEST_DATABASE_URL`, the Postgres integration suite is skipped and the skip text says to set that variable. The health route tests do not need a database: one uses a reachable client and one uses a client that throws.

To run the integration test against the Compose database:

```bash
TEST_DATABASE_URL=postgres://ssdeals:ssdeals@127.0.0.1:5432/ssdeals pnpm test
```

Use a database you can throw away. The integration test only runs `SELECT 1` and `GET /health`.

## Shutdown

`SIGTERM` and `SIGINT` close the HTTP server (API) or stop the heartbeat timer (worker), then close the Postgres pool. A second signal does not close them again. `docker compose stop` sends `SIGTERM`. The logs should include `shutdown started` and `shutdown complete`.

## Common errors

**`DATABASE_URL is required`**  
The process was started without a connection string. Copy `.env.example` to `.env` for host commands. For Compose, the variable is set in the compose file unless you exported an empty `DATABASE_URL`.

**`DATABASE_URL must start with postgres://`**  
The value is not a Postgres URL.

**HTTP 503 and `"db": "down"`**  
The API is up and Postgres is not reachable. `docker compose ... stop postgres` produces this. Start Postgres again; the next request should return 200 without restarting the API. A health check can take up to two seconds while the client times out.

**`EADDRINUSE` on port 3000 or 5432**  
Something else is bound there. Stop it, or change the host port in the compose file. The process inside the container should keep using port 3000.

**`curl` cannot connect to localhost:3000**  
The port is published on `127.0.0.1` only. Use `http://127.0.0.1:3000/health`.

**Compose says `POSTGRES_PASSWORD` or `COMPOSE_DATABASE_URL` is required**  
You used `docker-compose.prod.yml` without exporting those variables. The dev file does not require them. `COMPOSE_DATABASE_URL` must use hostname `postgres`.

**`libatomic.so.1: cannot open shared object file` on Ubuntu**  
Install `libatomic1`, or run the processes from the Docker image.

**Integration test skipped**  
`TEST_DATABASE_URL` is unset. That is expected. Set it when you want the test to open a real connection.

**Docker build cannot find `pnpm-lock.yaml`**  
Run `pnpm install` on the host first so the lockfile exists, then build again.
