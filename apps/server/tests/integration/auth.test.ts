import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { buildApp } from '../../src/api/app.js';
import * as schema from '../../src/db/schema/index.js';
import { sessions, users } from '../../src/db/schema/index.js';
import {
  CSRF_ERROR,
  FORBIDDEN_ERROR,
  LOGIN_ERROR,
  RATE_LIMIT_ERROR,
  SIGN_IN_REQUIRED,
} from '../../src/modules/auth/messages.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { createRateLimiter } from '../../src/modules/auth/rate-limit.js';
import { hashSessionToken } from '../../src/modules/auth/token.js';
import type { FastifyInstance } from 'fastify';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);
const origin = 'http://localhost:3001';
const password = 'correct-horse-battery';

if (databaseUrl === '') {
  console.info(
    'Auth integration tests skipped: set TEST_DATABASE_URL to a database whose name ends with _test.',
  );
} else {
  assertTestDatabaseName(databaseUrl);
}

type Database = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Database | undefined;

function assertTestDatabaseName(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(
      'Refusing to run auth integration tests: TEST_DATABASE_URL is not a valid URL.',
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run auth integration tests: database name "${databaseName || '(empty)'}" must end with "_test".`,
    );
  }
}

function database(): Database {
  if (db === undefined) {
    throw new Error('auth integration database is not connected');
  }
  return db;
}

async function truncate(): Promise<void> {
  await pool?.query(`
    TRUNCATE TABLE
      sessions,
      publications,
      content_drafts,
      price_snapshots,
      deals,
      affiliate_links,
      channels,
      products,
      users,
      settings,
      audit_log
    RESTART IDENTITY CASCADE
  `);
}

async function insertUser(
  username: string,
  role: 'owner' | 'clerk',
  isActive = true,
): Promise<void> {
  await database()
    .insert(users)
    .values({
      username,
      role,
      isActive,
      passwordHash: await hashPassword(password),
    });
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie ?? '');
  const match = /ssd_session=([^;]+)/.exec(header);
  const token = match?.[1];
  if (token === undefined || token.length === 0) {
    throw new Error('login response did not set a session cookie');
  }
  return `ssd_session=${token}`;
}

describe.skipIf(databaseUrl === '')('auth http', () => {
  let app: FastifyInstance | undefined;

  function server(): FastifyInstance {
    if (app === undefined) {
      throw new Error('auth test app is not built');
    }
    return app;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000, max: 5 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
  });

  beforeEach(async () => {
    await truncate();
    await insertUser('ada', 'owner');
    await insertUser('grace', 'clerk');
    await app?.close();
    app = buildApp({
      checkDb: async () => true,
      auth: {
        db: database(),
        cookieName: 'ssd_session',
        cookieSecure: false,
        allowedOrigins: [origin],
        failureDelayMs: 0,
        enableTestRoutes: true,
        rateLimiter: createRateLimiter(),
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function login(
    username: string,
    secret: string,
    extra: { origin?: string; remoteAddress?: string } = {},
  ) {
    return server().inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: extra.origin === '' ? {} : { origin: extra.origin ?? origin },
      payload: { username, password: secret },
      remoteAddress: extra.remoteAddress ?? '127.0.0.1',
    });
  }

  it('logs an owner in, returns the profile, and logs out', async () => {
    const signedIn = await login('ada', password);
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json()).toEqual({
      user: expect.objectContaining({ username: 'ada', role: 'owner' }),
    });
    const cookie = sessionCookie(signedIn.headers['set-cookie']);
    expect(cookie).not.toMatch(/scrypt/);
    expect(String(signedIn.headers['set-cookie'])).toContain('HttpOnly');
    expect(String(signedIn.headers['set-cookie'])).toContain('SameSite=Lax');
    expect(String(signedIn.headers['set-cookie'])).not.toContain('Secure');
    expect(signedIn.headers['x-content-type-options']).toBe('nosniff');
    expect(signedIn.headers['x-frame-options']).toBe('DENY');

    const me = await server().inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ username: 'ada', role: 'owner' });

    const loggedOut = await server().inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin },
    });
    expect(loggedOut.statusCode).toBe(204);

    const after = await server().inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
    const [row] = await database()
      .select()
      .from(sessions)
      .where(eq(sessions.id, hashFromCookie(cookie)));
    expect(row?.revokedAt).toBeInstanceOf(Date);
  });

  it('uses the same error for an unknown user, a wrong password, and an inactive user', async () => {
    await insertUser('inactive', 'clerk', false);
    const unknown = await login('missing', password);
    const wrong = await login('ada', 'not-the-password');
    const inactive = await login('inactive', password);

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(inactive.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: LOGIN_ERROR });
    expect(wrong.json()).toEqual(unknown.json());
    expect(inactive.json()).toEqual(unknown.json());
  });

  it('rejects a session that is idle-expired or past the absolute deadline', async () => {
    const signedIn = await login('ada', password);
    const cookie = sessionCookie(signedIn.headers['set-cookie']);
    const tokenHash = hashFromCookie(cookie);

    await database()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.id, tokenHash));
    const idle = await server().inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(idle.statusCode).toBe(401);

    await database()
      .update(sessions)
      .set({
        createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: null,
      })
      .where(eq(sessions.id, tokenHash));
    const absolute = await server().inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(absolute.statusCode).toBe(401);
    expect(absolute.json()).toEqual({ error: SIGN_IN_REQUIRED });
  });

  it('rejects state-changing requests whose Origin is missing or not allowed', async () => {
    const missing = await login('ada', password, { origin: '' });
    const foreign = await login('ada', password, { origin: 'https://evil.example' });

    expect(missing.statusCode).toBe(403);
    expect(foreign.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: CSRF_ERROR });
    expect(foreign.json()).toEqual({ error: CSRF_ERROR });
  });

  it('lets an owner through the owner guard and keeps a clerk out', async () => {
    const ownerCookie = sessionCookie((await login('ada', password)).headers['set-cookie']);
    const clerkCookie = sessionCookie((await login('grace', password)).headers['set-cookie']);

    const ownerAllowed = await server().inject({
      method: 'GET',
      url: '/api/auth/test/owner',
      headers: { cookie: ownerCookie },
    });
    const clerkForbidden = await server().inject({
      method: 'GET',
      url: '/api/auth/test/owner',
      headers: { cookie: clerkCookie },
    });
    const anonymous = await server().inject({ method: 'GET', url: '/api/auth/test/owner' });
    const clerkAllowed = await server().inject({
      method: 'GET',
      url: '/api/auth/test/clerk',
      headers: { cookie: clerkCookie },
    });
    const ownerOnClerk = await server().inject({
      method: 'GET',
      url: '/api/auth/test/clerk',
      headers: { cookie: ownerCookie },
    });
    const either = await server().inject({
      method: 'GET',
      url: '/api/auth/test/user',
      headers: { cookie: clerkCookie },
    });

    expect(ownerAllowed.statusCode).toBe(200);
    expect(ownerAllowed.json()).toEqual({ ok: true, role: 'owner' });
    expect(clerkForbidden.statusCode).toBe(403);
    expect(clerkForbidden.json()).toEqual({ error: FORBIDDEN_ERROR });
    expect(anonymous.statusCode).toBe(401);
    expect(clerkAllowed.statusCode).toBe(200);
    expect(ownerOnClerk.statusCode).toBe(403);
    expect(either.statusCode).toBe(200);
  });

  it('does not register the guard routes unless tests ask for them', async () => {
    await server().close();
    app = buildApp({
      checkDb: async () => true,
      auth: {
        db: database(),
        cookieName: 'ssd_session',
        cookieSecure: false,
        allowedOrigins: [origin],
        failureDelayMs: 0,
        enableTestRoutes: false,
      },
    });
    const response = await server().inject({ method: 'GET', url: '/api/auth/test/owner' });
    expect(response.statusCode).toBe(404);
  });

  it('returns 429 after five failed attempts for the same username and IP', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await login('ada', 'not-the-password', { remoteAddress: '203.0.113.50' });
      expect(failed.statusCode).toBe(401);
    }
    const limited = await login('ada', 'not-the-password', { remoteAddress: '203.0.113.50' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: RATE_LIMIT_ERROR });
    expect(limited.headers['retry-after']).toBeDefined();

    const otherIp = await login('ada', password, { remoteAddress: '203.0.113.51' });
    expect(otherIp.statusCode).toBe(200);
  });
});

function hashFromCookie(cookie: string): string {
  return hashSessionToken(cookie.slice('ssd_session='.length));
}
