import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import * as schema from '../../src/db/schema/index.js';
import {
  affiliateLinks,
  auditLog,
  channels,
  contentDrafts,
  deals,
  products,
  publications,
  settings,
  users,
} from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { runSchedulerTick } from '../../src/modules/publishing/scheduler.js';
import { recoverInterruptedPublishing } from '../../src/modules/publishing/service.js';
import type { TelegramClient, TelegramResult } from '../../src/modules/publishing/telegram.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);
const origin = 'http://localhost:3001';
const password = 'correct-horse-battery';

if (databaseUrl === '') {
  console.info(
    'Scheduler integration tests skipped: set TEST_DATABASE_URL to a database whose name ends with _test.',
  );
} else {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run scheduler tests against database "${name}".`);
  }
}

type Database = NodePgDatabase<typeof schema>;
const clock = { now: new Date('2026-11-08T04:00:00.000Z') };
const calls: string[] = [];
let nextResult: TelegramResult = { kind: 'ok', messageId: 21 };
let releaseSend: (() => void) | undefined;
let sendEntered: (() => void) | undefined;

const client: TelegramClient = {
  async sendText(input) {
    calls.push(input.text);
    sendEntered?.();
    if (releaseSend !== undefined) {
      const release = releaseSend;
      await new Promise<void>((resolve) => {
        releaseSend = resolve;
        release();
      });
    }
    return nextResult;
  },
  async sendPhoto() {
    calls.push('photo');
    return nextResult;
  },
};

let pool: Pool | undefined;
let db: Database | undefined;
let passwordHash = '';
let adaId = '';
let graceId = '';

function database(): Database {
  if (db === undefined || pool === undefined) {
    throw new Error('scheduler test database is not connected');
  }
  return db;
}

describe.skipIf(databaseUrl === '')('scheduler', () => {
  let app: FastifyInstance | undefined;

  function server(): FastifyInstance {
    if (app === undefined) throw new Error('scheduler test app is not built');
    return app;
  }

  beforeAll(async () => {
    passwordHash = await hashPassword(password);
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000, max: 5 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    app = buildApp({
      checkDb: async () => true,
      auth: {
        db: database(),
        cookieName: 'ssd_session',
        cookieSecure: false,
        allowedOrigins: [origin],
        failureDelayMs: 0,
        now: () => clock.now,
      },
      deals: {
        amazonTag: 'example-21',
        shortLinkHosts: ['amzn.to', 'link.amazon'],
        uploadDir: '/tmp/ss-deals-scheduler',
        maxUploadBytes: 4_096,
      },
      publishing: {
        enabled: true,
        channel: '@deals_channel',
        token: '123456:SECRETTOKEN',
        timeoutMs: 15000,
        dailyLimit: 8,
        minGapMinutes: 0,
        maxLateMinutes: 120,
        linkStyle: 'text',
        postFooter: '',
        uploadDir: '/tmp/ss-deals-scheduler',
        shortLinkHosts: ['amzn.to', 'link.amazon'],
        client,
      },
    });
  });

  beforeEach(async () => {
    clock.now = new Date('2026-11-08T04:00:00.000Z');
    calls.length = 0;
    nextResult = { kind: 'ok', messageId: 21 };
    releaseSend = undefined;
    sendEntered = undefined;
    await pool?.query(`
      TRUNCATE TABLE
        sessions, publications, content_drafts, price_snapshots, deals,
        affiliate_links, channels, products, users, settings, audit_log
      RESTART IDENTITY CASCADE
    `);
    adaId = await insertUser('ada', 'owner');
    graceId = await insertUser('grace', 'clerk');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('posts due deals in order, waits for the gap and the daily limit, and skips a pause', async () => {
    const admin = await login(server(), 'ada');
    const early = await seedApproved('B0EARLY001', 'Early');
    const later = await seedApproved('B0LATER001', 'Later');
    expect((await schedule(server(), admin, early, minutesFromNow(5))).statusCode).toBe(200);
    expect((await schedule(server(), admin, later, minutesFromNow(20))).json().deal.status).toBe(
      'scheduled',
    );
    clock.now = minutesFromNow(5);
    expect((await tick()).kind).toBe('sent');
    expect(calls).toEqual(['<b>Early</b>']);
    clock.now = minutesFromNow(20);
    expect((await tick()).kind).toBe('sent');
    expect(calls).toEqual(['<b>Early</b>', '<b>Later</b>']);

    const held = await seedApproved('B0GAP00001', 'Gap');
    await database()
      .update(publications)
      .set({ publishedAt: clock.now })
      .where(eq(publications.status, 'published'));
    await database().insert(settings).values({ key: 'min_gap_minutes', value: 30 });
    await schedule(server(), admin, held, new Date(clock.now.getTime() + 60_000));
    clock.now = new Date(clock.now.getTime() + 60_000);
    expect((await tick()).kind).toBe('gap');
    expect(calls).toHaveLength(2);
    clock.now = new Date(clock.now.getTime() + 30 * 60_000);
    expect((await tick()).kind).toBe('sent');

    const blocked = await seedApproved('B0LIMIT001', 'Limited');
    clock.now = new Date('2026-11-08T18:20:00.000Z');
    const laterAdmin = await login(server(), 'ada');
    await database().insert(settings).values({ key: 'daily_limit', value: 1 });
    expect(
      (await schedule(server(), laterAdmin, blocked, new Date(clock.now.getTime() + 60_000)))
        .statusCode,
    ).toBe(200);
    clock.now = new Date(clock.now.getTime() + 60_000);
    expect((await tick()).kind).toBe('limited');
    const [waiting] = await database()
      .select({ status: publications.status })
      .from(publications)
      .where(eq(publications.dealId, blocked.id));
    expect(waiting?.status).toBe('queued');
    clock.now = new Date('2026-11-08T18:40:00.000Z');
    expect((await tick()).kind).toBe('sent');

    await database().delete(settings);
    const pausedDeal = await seedApproved('B0PAUSE001', 'Paused');
    expect(
      (await schedule(server(), laterAdmin, pausedDeal, new Date(clock.now.getTime() + 60_000)))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await server().inject({
          method: 'POST',
          url: '/api/admin/publishing/pause',
          headers: { cookie: laterAdmin, origin },
        })
      ).statusCode,
    ).toBe(200);
    clock.now = new Date(clock.now.getTime() + 60_000);
    expect((await tick()).kind).toBe('paused');
    expect(
      (
        await server().inject({
          method: 'POST',
          url: '/api/admin/publishing/resume',
          headers: { cookie: laterAdmin, origin },
        })
      ).statusCode,
    ).toBe(200);
    expect((await tick()).kind).toBe('sent');
    const names = (await database().select({ action: auditLog.action }).from(auditLog)).map(
      (row) => row.action,
    );
    expect(names).toContain('publishing.pause');
    expect(names).toContain('publishing.resume');
    expect(names).toContain('deal.schedule');
  });

  it('drops a missed window, retries twice, and never retries uncertain', async () => {
    const admin = await login(server(), 'ada');
    const missed = await seedApproved('B0MISSED01', 'Missed');
    await schedule(server(), admin, missed, minutesFromNow(10));
    await database()
      .update(publications)
      .set({ scheduledFor: new Date(clock.now.getTime() - 3 * 60 * 60_000) })
      .where(eq(publications.dealId, missed.id));
    expect(await tick()).toMatchObject({ kind: 'missed', count: 1 });
    expect(calls).toHaveLength(0);
    const [missedDeal] = await database()
      .select({ status: deals.status, reviewNote: deals.reviewNote })
      .from(deals)
      .where(eq(deals.id, missed.id));
    expect(missedDeal).toMatchObject({
      status: 'approved',
      reviewNote: 'Missed its scheduled time (the server was off or paused)',
    });
    expect(
      await database()
        .select({ id: publications.id })
        .from(publications)
        .where(eq(publications.dealId, missed.id)),
    ).toHaveLength(0);

    const retry = await seedApproved('B0RETRY001', 'Retry');
    await schedule(server(), admin, retry, minutesFromNow(1));
    clock.now = minutesFromNow(1);
    nextResult = { kind: 'not_sent', reason: 'connection refused' };
    expect(sentStatus(await tick())).toBe('queued');
    expect(calls).toHaveLength(1);
    let row = await publicationFor(retry.id);
    expect(row.attempts).toBe(1);
    expect(row.scheduledFor?.getTime()).toBe(clock.now.getTime() + 60_000);
    expect((await tick()).kind).toBe('idle');
    clock.now = new Date(clock.now.getTime() + 60_000);
    expect(sentStatus(await tick())).toBe('queued');
    row = await publicationFor(retry.id);
    expect(row.attempts).toBe(2);
    expect(row.scheduledFor?.getTime()).toBe(clock.now.getTime() + 5 * 60_000);
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    expect(sentStatus(await tick())).toBe('failed');
    expect(calls).toHaveLength(3);
    const [returned] = await database()
      .select({ status: deals.status })
      .from(deals)
      .where(eq(deals.id, retry.id));
    expect(returned?.status).toBe('approved');
    clock.now = new Date(clock.now.getTime() + 15 * 60_000);
    await tick();
    expect(calls).toHaveLength(3);

    const unsure = await seedApproved('B0UNSURE02', 'Unsure');
    await schedule(server(), admin, unsure, new Date(clock.now.getTime() + 60_000));
    clock.now = new Date(clock.now.getTime() + 60_000);
    nextResult = { kind: 'uncertain', reason: 'timeout' };
    expect(sentStatus(await tick())).toBe('uncertain');
    const before = calls.length;
    clock.now = new Date(clock.now.getTime() + 2 * 60 * 60_000);
    await tick();
    expect(calls).toHaveLength(before);
    expect((await publicationFor(unsure.id)).status).toBe('uncertain');
  });

  it('recovers a stuck publish, refuses a second worker, and blocks edits while scheduled', async () => {
    const admin = await login(server(), 'ada');
    const clerk = await login(server(), 'grace');
    const stuck = await seedApproved('B0STUCK001', 'Stuck');
    const channelId = await ensureChannel();
    await database()
      .insert(publications)
      .values({
        dealId: stuck.id,
        productId: stuck.productId,
        channelId,
        contentDraftId: await currentDraft(stuck.id),
        status: 'publishing',
        mode: 'text',
        linkKind: 'tagged',
        origin: 'app',
        attempts: 1,
        updatedAt: new Date(clock.now.getTime() - 3 * 60_000),
      });
    expect(await recoverInterruptedPublishing(database(), clock.now)).toBe(1);
    expect((await publicationFor(stuck.id)).lastError).toBe(
      'Server stopped while posting. Check the channel.',
    );

    const fresh = await seedApproved('B0FRESH001', 'Fresh');
    await database()
      .insert(publications)
      .values({
        dealId: fresh.id,
        productId: fresh.productId,
        channelId,
        contentDraftId: await currentDraft(fresh.id),
        status: 'publishing',
        mode: 'text',
        linkKind: 'tagged',
        origin: 'app',
        attempts: 1,
        updatedAt: clock.now,
      });
    expect(await recoverInterruptedPublishing(database(), clock.now)).toBe(0);
    expect((await tick()).kind).toBe('busy');
    await database().delete(publications).where(eq(publications.dealId, fresh.id));

    const due = await seedApproved('B0DOUBLE01', 'Double');
    await schedule(server(), admin, due, new Date(clock.now.getTime() + 60_000));
    clock.now = new Date(clock.now.getTime() + 60_000);
    nextResult = { kind: 'ok', messageId: 30 };
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    sendEntered = entered;
    releaseSend = () => undefined;
    const first = tick();
    await started;
    expect((await tick()).kind).toBe('busy');
    releaseSend?.();
    releaseSend = undefined;
    sendEntered = undefined;
    expect((await first).kind).toBe('sent');
    expect(calls.filter((text) => text === '<b>Double</b>')).toHaveLength(1);

    const scheduled = await seedApproved('B0EDIT0001', 'Editable');
    const booked = await schedule(
      server(),
      admin,
      scheduled,
      new Date(clock.now.getTime() + 3_600_000),
    );
    const edit = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${scheduled.id}`,
      headers: { cookie: admin, origin },
      payload: editBody(booked.json().deal.updatedAt as string),
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toMatch(/Unschedule/);
    const opened = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${scheduled.id}/unschedule`,
      headers: { cookie: admin, origin },
      payload: { updatedAt: booked.json().deal.updatedAt },
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json().deal.status).toBe('approved');
    const edited = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${scheduled.id}`,
      headers: { cookie: admin, origin },
      payload: editBody(opened.json().deal.updatedAt as string, 'Renamed'),
    });
    expect(edited.statusCode).toBe(200);
    expect(
      (
        await server().inject({
          method: 'POST',
          url: `/api/admin/deals/${scheduled.id}/schedule`,
          headers: { cookie: clerk, origin },
          payload: {
            updatedAt: edited.json().updatedAt,
            scheduledFor: new Date(clock.now.getTime() + 30 * 60_000).toISOString(),
          },
        })
      ).statusCode,
    ).toBe(403);
    const past = await seedApproved('B0PAST0001', 'Past');
    expect(
      (await schedule(server(), admin, past, new Date(clock.now.getTime() - 60_000))).statusCode,
    ).toBe(400);
    const far = await seedApproved('B0FAR000001', 'Far');
    expect(
      (await schedule(server(), admin, far, new Date(clock.now.getTime() + 8 * 24 * 60 * 60_000)))
        .statusCode,
    ).toBe(400);
    const saved = await server().inject({
      method: 'PATCH',
      url: '/api/admin/publishing/settings',
      headers: { cookie: admin, origin },
      payload: { dailyLimit: 4, minGapMinutes: 10 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().dailyLimit).toBe(4);
    expect(saved.json()).toMatchObject({
      queued: expect.any(Number),
      uncertain: expect.any(Number),
    });
    expect(
      (
        await server().inject({
          method: 'PATCH',
          url: '/api/admin/publishing/settings',
          headers: { cookie: admin, origin },
          payload: { dailyLimit: 0, minGapMinutes: 10 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server().inject({
          method: 'PATCH',
          url: '/api/admin/publishing/settings',
          headers: { cookie: clerk, origin },
          payload: { dailyLimit: 4, minGapMinutes: 10 },
        })
      ).statusCode,
    ).toBe(403);
    const names = (await database().select({ action: auditLog.action }).from(auditLog)).map(
      (row) => row.action,
    );
    expect(names).toContain('deal.schedule');
    expect(names).toContain('deal.unschedule');
    expect(names).toContain('publishing.settings');
  });
});

function sentStatus(result: Awaited<ReturnType<typeof tick>>): string {
  if (result.kind !== 'sent') {
    throw new Error(`expected a send, got ${result.kind}`);
  }
  return result.status;
}

function minutesFromNow(minutes: number): Date {
  return new Date(clock.now.getTime() + minutes * 60_000);
}

function tick() {
  if (pool === undefined) throw new Error('pool missing');
  return runSchedulerTick(
    pool,
    database(),
    { id: adaId, now: clock.now },
    {
      client,
      config: {
        enabled: true,
        channel: '@deals_channel',
        token: '123456:SECRETTOKEN',
        dailyLimit: 8,
        minGapMinutes: 0,
        maxLateMinutes: 120,
        linkStyle: 'text',
        postFooter: '',
        uploadDir: '/tmp/ss-deals-scheduler',
        shortLinkHosts: ['amzn.to', 'link.amazon'],
      },
    },
  );
}

async function publicationFor(dealId: string) {
  const [row] = await database()
    .select({
      status: publications.status,
      attempts: publications.attempts,
      scheduledFor: publications.scheduledFor,
      lastError: publications.lastError,
    })
    .from(publications)
    .where(eq(publications.dealId, dealId));
  if (row === undefined) throw new Error('publication missing');
  return row;
}

async function ensureChannel(): Promise<string> {
  const [created] = await database()
    .insert(channels)
    .values({
      platform: 'telegram',
      name: '@deals_channel',
      username: '@deals_channel',
      isActive: true,
    })
    .onConflictDoNothing()
    .returning({ id: channels.id });
  if (created !== undefined) return created.id;
  const [existing] = await database()
    .select({ id: channels.id })
    .from(channels)
    .where(eq(channels.username, '@deals_channel'))
    .limit(1);
  if (existing === undefined) throw new Error('channel missing');
  return existing.id;
}

async function currentDraft(dealId: string): Promise<string> {
  const [row] = await database()
    .select({ id: contentDrafts.id })
    .from(contentDrafts)
    .where(eq(contentDrafts.dealId, dealId));
  if (row === undefined) throw new Error('draft missing');
  return row.id;
}

function editBody(updatedAt: string, title = 'Editable') {
  return {
    title,
    price: '1000',
    oldPrice: null,
    offer: null,
    highlights: [],
    shortLink: null,
    sourceNote: null,
    previewEnabled: true,
    oldPriceVerified: false,
    updatedAt,
  };
}

async function insertUser(username: string, role: 'owner' | 'clerk'): Promise<string> {
  const [row] = await database()
    .insert(users)
    .values({ username, role, displayName: username, isActive: true, passwordHash })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('user insert failed');
  return row.id;
}

async function login(app: FastifyInstance, username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username, password },
  });
  const session = /ssd_session=([^;]+)/.exec(String(response.headers['set-cookie'] ?? ''))?.[1];
  if (session === undefined) throw new Error('login did not set a session cookie');
  return `ssd_session=${session}`;
}

function schedule(
  app: FastifyInstance,
  cookie: string,
  deal: { id: string; updatedAt: Date },
  when: Date,
) {
  return app.inject({
    method: 'POST',
    url: `/api/admin/deals/${deal.id}/schedule`,
    headers: { cookie, origin },
    payload: { updatedAt: deal.updatedAt.toISOString(), scheduledFor: when.toISOString() },
  });
}

async function seedApproved(asin: string, title: string) {
  const tagged = `https://www.amazon.in/dp/${asin}?tag=example-21`;
  const [product] = await database()
    .insert(products)
    .values({ source: 'amazon', externalId: asin, canonicalUrl: tagged, title: asin })
    .returning();
  if (product === undefined) {
    throw new Error('product seed failed');
  }
  const [link] = await database()
    .insert(affiliateLinks)
    .values({
      productId: product.id,
      platform: 'amazon',
      originalUrl: `https://www.amazon.in/dp/${asin}`,
      affiliateUrl: tagged,
      shortUrl: `https://amzn.to/${asin.toLowerCase()}`,
      affiliateTag: 'example-21',
      verification: 'tag_appended',
      validationStatus: 'structure_ok',
      createdBy: adaId,
    })
    .returning();
  if (link === undefined) {
    throw new Error('link seed failed');
  }
  const [deal] = await database()
    .insert(deals)
    .values({
      productId: product.id,
      linkId: link.id,
      status: 'approved',
      title,
      pricePaise: 100000,
      highlights: [],
      previewEnabled: true,
      createdBy: graceId,
    })
    .returning();
  if (deal === undefined) throw new Error('deal seed failed');
  await database()
    .insert(contentDrafts)
    .values({
      dealId: deal.id,
      version: 1,
      bodyHtml: `<b>${title}</b>`,
      source: 'template',
      isCurrent: true,
    });
  return deal;
}
