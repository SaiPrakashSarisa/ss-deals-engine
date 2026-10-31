import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config/env.js';
import { createDb } from '../lib/db.js';
import { isEntrypoint } from '../lib/entrypoint.js';
import { createLogger, startupSummary } from '../lib/logger.js';
import { createShutdownHandler, installSignalHandlers } from '../shutdown.js';

const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_PATH = '/tmp/ss-deals-worker-heartbeat';

function writeHeartbeat(): void {
  writeFileSync(HEARTBEAT_PATH, `${Date.now()}\n`);
}

export async function startWorker(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info(startupSummary(config), 'worker starting');

  const { pool } = createDb(config.DATABASE_URL, logger);
  writeHeartbeat();
  logger.info({ uptimeSeconds: Math.floor(process.uptime()) }, 'heartbeat');

  const timer = setInterval(() => {
    writeHeartbeat();
    logger.info({ uptimeSeconds: Math.floor(process.uptime()) }, 'heartbeat');
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = createShutdownHandler({
    closeServer: async () => {
      clearInterval(timer);
    },
    closePool: () => pool.end(),
    logger,
  });
  installSignalHandlers(shutdown, logger);
}

if (isEntrypoint(import.meta.url)) {
  startWorker().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'worker failed to start';
    console.error(message);
    process.exit(1);
  });
}
