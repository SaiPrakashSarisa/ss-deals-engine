import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from '../../src/api/app.js';
import { checkDb } from '../../src/lib/db.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';

if (databaseUrl === '') {
  console.info(
    'Postgres integration test skipped: set TEST_DATABASE_URL to run it against PostgreSQL.',
  );
}

describe('postgres integration', () => {
  it.skipIf(databaseUrl === '')(
    'GET /health returns 200 and db up against TEST_DATABASE_URL',
    async () => {
      const pool = new Pool({
        connectionString: databaseUrl,
        connectionTimeoutMillis: 2_000,
      });

      try {
        const reachable = await checkDb(pool);
        expect(reachable).toBe(true);

        const app = buildApp({ checkDb: () => checkDb(pool) });
        try {
          const response = await app.inject({ method: 'GET', url: '/health' });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toMatchObject({ status: 'ok', db: 'up' });
        } finally {
          await app.close();
        }
      } finally {
        await pool.end();
      }
    },
  );
});
