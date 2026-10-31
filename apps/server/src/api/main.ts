import { loadConfig } from '../config/env.js';
import { isEntrypoint } from '../lib/entrypoint.js';
import { checkDb, createDb } from '../lib/db.js';
import { createLogger, flushLogger, startupSummary } from '../lib/logger.js';
import { installSignalHandlers, createShutdownHandler } from '../shutdown.js';
import { buildApp } from './app.js';

export async function startApi(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info(startupSummary(config), 'api starting');

  const { pool } = createDb(config.DATABASE_URL, logger);
  const app = buildApp({
    logger,
    checkDb: () => checkDb(pool),
  });

  const shutdown = createShutdownHandler({
    closeServer: () => app.close(),
    closePool: () => pool.end(),
    logger,
  });
  installSignalHandlers(shutdown, logger);

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (error) {
    logger.error({ err: error }, 'api failed to start');
    await flushLogger(logger);
    throw error;
  }
}

if (isEntrypoint(import.meta.url)) {
  startApi().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'api failed to start';
    console.error(message);
    process.exit(1);
  });
}
