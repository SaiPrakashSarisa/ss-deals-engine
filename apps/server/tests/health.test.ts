import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { checkDb, type Queryable } from '../src/lib/db.js';

describe('GET /health', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('returns 200 and db up when the database is reachable', async () => {
    const database: Queryable = {
      query: async () => ({ rows: [{ '?column?': 1 }] }),
    };
    app = buildApp({ checkDb: () => checkDb(database) });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', db: 'up' });
    expect(response.json<{ uptimeSeconds: number }>().uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 when the database is mocked down', async () => {
    const database: Queryable = {
      query: async () => {
        throw new Error('connection refused');
      },
    };
    app = buildApp({ checkDb: () => checkDb(database) });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', db: 'down' });
  });
});
