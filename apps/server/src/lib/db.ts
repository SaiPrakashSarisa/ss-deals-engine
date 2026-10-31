import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import * as schema from './schema.js';

export type Queryable = {
  query: (sql: string) => Promise<unknown>;
};

export type Database = {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
};

const databaseUrlPattern = /postgres(?:ql)?:\/\/\S+/gi;

function safeDbError(error: Error): { name: string; code?: string; message: string } {
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return {
    name: error.name,
    ...(code === undefined ? {} : { code }),
    message: error.message.replace(databaseUrlPattern, 'postgres://[redacted]'),
  };
}

export function createDb(connectionString: string, logger: Logger): Database {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2_000,
  });

  pool.on('error', (error: Error) => {
    logger.error(safeDbError(error), 'database pool error');
  });

  const db = drizzle(pool, { schema });
  return { pool, db };
}

export async function checkDb(client: Queryable): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('database check timed out'));
      }, 2_000);
    });
    await Promise.race([client.query('SELECT 1'), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
