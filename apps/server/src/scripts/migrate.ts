import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config/env.js';
import { createDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const { pool, db } = createDb(config.DATABASE_URL, logger);

  try {
    await migrate(db, { migrationsFolder });
    logger.info({ migrationsFolder }, 'migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'migration failed';
  console.error(message);
  process.exit(1);
});
