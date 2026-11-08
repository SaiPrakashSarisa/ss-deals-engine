import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
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
import type { DealStatus } from '../../src/modules/deals/status.js';
import type { TelegramClient, TelegramResult } from '../../src/modules/publishing/telegram.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);
const origin = 'http://localhost:3001';
const password = 'correct-horse-battery';
const token = '123456:SECRETTOKEN';

if (databaseUrl === '') {
  console.info(
    'Publishing integration tests skipped: set TEST_DATABASE_URL to a database whose name ends with _test.',
  );
} else {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run publishing tests against database "${name}".`);
  }
}

type Database = NodePgDatabase<typeof schema>;
type Call = { kind: 'text' | 'photo'; text: string; previewEnabled?: boolean; bytes?: number };

let pool: Pool | undefined;
let db: Database | undefined;
let uploadDir = '';
let passwordHash = '';
let adaId = '';
let graceId = '';
const calls: Call[] = [];
const logs: string[] = [];
let nextResult: TelegramResult = { kind: 'ok', messageId: 11 };
let explodeRecord = false;
let sawPublishing = false;

const client: TelegramClient = {
  async sendText(input) {
    const [row] = await database()
      .select({ status: publications.status })
      .from(publications)
      .where(eq(publications.status, 'publishing'))
      .limit(1);
    sawPublishing = row?.status === 'publishing';
    calls.push({ kind: 'text', text: input.text, previewEnabled: input.previewEnabled });
    return nextResult;
  },
  async sendPhoto(input) {
    calls.push({ kind: 'photo', text: input.caption, bytes: input.bytes.byteLength });
    return nextResult;
  },
};

function database(): Database {
  if (db === undefined) {
    throw new Error('publishing test database is not connected');
  }
  return db;
}

describe.skipIf(databaseUrl === '')('publish now', () => {
  let app: FastifyInstance | undefined;
  let disabled: FastifyInstance | undefined;

  function server(): FastifyInstance {
    if (app === undefined) {
      throw new Error('publishing test app is not built');
    }
    return app;
  }

  beforeAll(async () => {
    uploadDir = await mkdtemp(path.join(tmpdir(), 'ss-deals-publish-'));
    passwordHash = await hashPassword(password);
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000, max: 5 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    const auth = {
      db: database(),
      cookieName: 'ssd_session',
      cookieSecure: false,
      allowedOrigins: [origin],
      failureDelayMs: 0,
    };
    const dealsOptions = {
      amazonTag: 'example-21',
      shortLinkHosts: ['amzn.to', 'link.amazon'],
      uploadDir,
      maxUploadBytes: 4_096,
    };
    const publishing = {
      enabled: true,
      channel: '@deals_channel',
      token,
      timeoutMs: 15000,
      dailyLimit: 8,
      linkStyle: 'text' as const,
      postFooter: '',
      uploadDir,
      shortLinkHosts: ['amzn.to', 'link.amazon'],
      client,
      logger: {
        error(fields: Record<string, unknown>) {
          logs.push(JSON.stringify(fields));
        },
      },
      beforeRecord: async () => {
        if (explodeRecord) {
          explodeRecord = false;
          throw new Error('disk full');
        }
      },
    };
    app = buildApp({ checkDb: async () => true, auth, deals: dealsOptions, publishing });
    disabled = buildApp({
      checkDb: async () => true,
      auth,
      deals: dealsOptions,
      publishing: { ...publishing, enabled: false, client },
    });
  });

  beforeEach(async () => {
    calls.length = 0;
    logs.length = 0;
    nextResult = { kind: 'ok', messageId: 11 };
    explodeRecord = false;
    sawPublishing = false;
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
    await disabled?.close();
    await pool?.end();
    await rm(uploadDir, { recursive: true, force: true });
  });

  it('publishes text and photo posts, and refuses a caption of 1024 or more before sending', async () => {
    const admin = await login(server(), 'ada');
    const textDeal = await seedApproved('B0TEXT0001', 'Text kettle', 100000);
    const text = await publish(server(), admin, textDeal.id, textDeal.updatedAt);
    expect(text.statusCode).toBe(200);
    expect(text.json().deal.status).toBe('published');
    expect(text.json().publication.externalMessageId).toBe('11');
    expect(calls).toEqual([{ kind: 'text', text: '<b>Text kettle</b>', previewEnabled: true }]);
    expect(sawPublishing).toBe(true);
    expect(JSON.stringify(text.json())).not.toContain(token);

    const photoName = `${'ab'.repeat(16)}.png`;
    await writeFile(path.join(uploadDir, photoName), Buffer.from('png-bytes'));
    const photoDeal = await seedApproved('B0PHOTO001', 'Photo kettle', 90000, {
      imagePath: photoName,
      imageMime: 'image/png',
      previewEnabled: false,
    });
    nextResult = { kind: 'ok', messageId: 12 };
    const photo = await publish(server(), admin, photoDeal.id, photoDeal.updatedAt);
    expect(photo.statusCode).toBe(200);
    expect(calls.at(-1)).toMatchObject({ kind: 'photo', text: '<b>Photo kettle</b>', bytes: 9 });

    const huge = await seedApproved('B0HUGE0001', 'Huge kettle', 80000, {
      imagePath: photoName,
      imageMime: 'image/png',
      caption: 'x'.repeat(1024),
    });
    const before = calls.length;
    const refused = await publish(server(), admin, huge.id, huge.updatedAt);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/1024/);
    expect(calls).toHaveLength(before);
    const [still] = await database()
      .select({ status: deals.status })
      .from(deals)
      .where(eq(deals.id, huge.id));
    expect(still?.status).toBe('approved');
  });

  it('records rate limits and rejection as failed, and timeouts as uncertain with no retry', async () => {
    const admin = await login(server(), 'ada');
    const limited = await seedApproved('B0LIMIT001', 'Limited', 100000);
    nextResult = { kind: 'rate_limited', retryAfterSeconds: 9 };
    const rate = await publish(server(), admin, limited.id, limited.updatedAt);
    expect(rate.statusCode).toBe(200);
    expect(rate.json().publication.status).toBe('failed');
    expect(rate.json().publication.lastError).toMatch(/9/);
    expect(rate.json().deal.status).toBe('approved');
    expect(calls).toHaveLength(1);

    const refused = await seedApproved('B0REJECT01', 'Refused', 100000);
    nextResult = { kind: 'rejected', reason: `nope ${token}` };
    const reject = await publish(server(), admin, refused.id, refused.updatedAt);
    expect(reject.json().publication.status).toBe('failed');
    expect(reject.json().publication.lastError).not.toContain(token);
    expect(reject.json().deal.status).toBe('approved');

    const unsure = await seedApproved('B0UNSURE01', 'Unsure', 100000);
    nextResult = { kind: 'uncertain', reason: 'The request to Telegram timed out.' };
    const timeout = await publish(server(), admin, unsure.id, unsure.updatedAt);
    expect(timeout.json().publication.status).toBe('uncertain');
    expect(timeout.json().deal.status).toBe('approved');
    expect(calls.filter((call) => call.text === '<b>Unsure</b>')).toHaveLength(1);
    const again = await publish(server(), admin, unsure.id, timeout.json().deal.updatedAt);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already in progress/);
    expect(calls.filter((call) => call.text === '<b>Unsure</b>')).toHaveLength(1);
    await database().update(deals).set({ status: 'published' }).where(eq(deals.id, unsure.id));
    const sibling = await seedOnProduct(unsure.productId, unsure.linkId, 'Sibling', 9000);
    const siblingRes = await publish(server(), admin, sibling.id, sibling.updatedAt);
    expect(siblingRes.statusCode).toBe(409);
    expect(siblingRes.json().error).toMatch(/already in progress/);
    await database().update(deals).set({ status: 'rejected' }).where(eq(deals.id, sibling.id));
    await database().update(deals).set({ status: 'approved' }).where(eq(deals.id, unsure.id));

    const posted = await server().inject({
      method: 'POST',
      url: `/api/admin/publications/${timeout.json().publication.id}/resolve`,
      headers: writeHeaders(admin),
      payload: { outcome: 'not_posted' },
    });
    expect(posted.statusCode).toBe(200);
    expect(posted.json().publication.status).toBe('failed');
    nextResult = { kind: 'uncertain', reason: 'timeout' };
    const second = await publish(server(), admin, unsure.id, posted.json().deal.updatedAt);
    expect(second.json().publication.status).toBe('uncertain');
    const confirmed = await server().inject({
      method: 'POST',
      url: `/api/admin/publications/${second.json().publication.id}/resolve`,
      headers: writeHeaders(admin),
      payload: { outcome: 'posted', messageId: '99' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().deal.status).toBe('published');
    expect(confirmed.json().publication.externalMessageId).toBe('99');
  });

  it('enforces the daily limit, pause, repost rule, approval, and admin access', async () => {
    const admin = await login(server(), 'ada');
    const clerk = await login(server(), 'grace');
    for (let index = 0; index < 8; index += 1) {
      await seedPublishedToday(`B0DAY${index.toString().padStart(4, '0')}`, 50000);
    }
    const blocked = await seedApproved('B0OVERLIM1', 'Over', 40000);
    const limited = await publish(server(), admin, blocked.id, blocked.updatedAt);
    expect(limited.statusCode).toBe(409);
    expect(limited.json().error).toMatch(/post limit/);
    const overridden = await publish(server(), admin, blocked.id, blocked.updatedAt, {
      override: true,
    });
    expect(overridden.statusCode).toBe(200);

    await database().insert(settings).values({ key: 'publishing_paused', value: true });
    const pausedDeal = await seedApproved('B0PAUSED01', 'Paused', 40000);
    const paused = await publish(server(), admin, pausedDeal.id, pausedDeal.updatedAt);
    expect(paused.statusCode).toBe(409);
    expect(paused.json().error).toMatch(/paused/);
    await database().delete(settings);
    await database()
      .update(publications)
      .set({ publishedAt: new Date(Date.now() - 3 * 86_400_000) })
      .where(eq(publications.status, 'published'));

    const lowerCase = await seedProduct('B0REPOST01');
    await seedHistory(lowerCase.product.id, lowerCase.link.id, 20000, 20000);
    const lower = await seedOnProduct(lowerCase.product.id, lowerCase.link.id, 'Lower', 15000);
    expect((await publish(server(), admin, lower.id, lower.updatedAt)).statusCode).toBe(200);
    const equalCase = await seedProduct('B0REPOST02');
    await seedHistory(equalCase.product.id, equalCase.link.id, 20000, 20000);
    const equal = await seedOnProduct(equalCase.product.id, equalCase.link.id, 'Equal', 20000);
    expect((await publish(server(), admin, equal.id, equal.updatedAt)).statusCode).toBe(409);
    const higherCase = await seedProduct('B0REPOST03');
    await seedHistory(higherCase.product.id, higherCase.link.id, 20000, 20000);
    const higher = await seedOnProduct(higherCase.product.id, higherCase.link.id, 'Higher', 25000);
    expect((await publish(server(), admin, higher.id, higher.updatedAt)).statusCode).toBe(409);

    const { product: unknownProduct, link: unknownLink } = await seedProduct('B0UNKNOWN1');
    await seedHistory(unknownProduct.id, unknownLink.id, 10000, null);
    const unknown = await seedOnProduct(unknownProduct.id, unknownLink.id, 'Unknown', 9000);
    const missing = await publish(server(), admin, unknown.id, unknown.updatedAt, {
      override: true,
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error).toMatch(/earlier posted price/);
    const confirmed = await publish(server(), admin, unknown.id, unknown.updatedAt, {
      override: true,
      confirmUnknownPrice: true,
    });
    expect(confirmed.statusCode).toBe(200);

    const waiting = await seedApproved('B0WAITING1', 'Waiting', 10000, {
      status: 'pending_approval',
    });
    expect((await publish(server(), admin, waiting.id, waiting.updatedAt)).statusCode).toBe(409);

    const open = await seedApproved('B0CLERK001', 'Clerk', 10000);
    expect((await publish(server(), clerk, open.id, open.updatedAt)).statusCode).toBe(403);
    expect(
      (
        await server().inject({
          method: 'POST',
          url: `/api/admin/deals/${open.id}/publish`,
          headers: { origin },
          payload: { updatedAt: open.updatedAt.toISOString() },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server().inject({
          method: 'POST',
          url: `/api/admin/deals/${open.id}/publish`,
          headers: { cookie: admin },
          payload: { updatedAt: open.updatedAt.toISOString() },
        })
      ).statusCode,
    ).toBe(403);

    if (disabled === undefined) {
      throw new Error('disabled app missing');
    }
    const off = await publish(disabled, admin, open.id, open.updatedAt);
    expect(off.statusCode).toBe(409);
    expect(off.json().error).toMatch(/turned off/);
    expect(calls.some((call) => call.text === '<b>Clerk</b>')).toBe(false);

    const status = await server().inject({
      method: 'GET',
      url: '/api/admin/publishing/status',
      headers: { cookie: admin },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      enabled: true,
      paused: false,
      dailyLimit: 8,
      channel: '@deals_channel',
    });
    expect(JSON.stringify(status.json())).not.toContain(token);
    const list = await server().inject({
      method: 'GET',
      url: '/api/admin/publications?status=published&page=1',
      headers: { cookie: admin },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.length).toBeGreaterThan(0);

    const audits = await database().select({ action: auditLog.action }).from(auditLog);
    expect(audits.map((row) => row.action)).toContain('deal.publish');
  });

  it('leaves the publication publishing when Telegram succeeded and the database update fails', async () => {
    const admin = await login(server(), 'ada');
    const deal = await seedApproved('B0RECORD01', 'Record', 10000);
    explodeRecord = true;
    nextResult = { kind: 'ok', messageId: 77 };
    const failed = await publish(server(), admin, deal.id, deal.updatedAt);
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error).toMatch(/could not be recorded/);
    expect(JSON.stringify(failed.json())).not.toContain(token);
    expect(logs.join('')).toContain('77');
    expect(logs.join('')).not.toContain(token);
    const [row] = await database()
      .select({ status: publications.status })
      .from(publications)
      .where(eq(publications.dealId, deal.id));
    expect(row?.status).toBe('publishing');
    const [saved] = await database()
      .select({ status: deals.status })
      .from(deals)
      .where(eq(deals.id, deal.id));
    expect(saved?.status).toBe('approved');
  });
});

async function insertUser(username: string, role: 'owner' | 'clerk'): Promise<string> {
  const [row] = await database()
    .insert(users)
    .values({ username, role, displayName: username, isActive: true, passwordHash })
    .returning({ id: users.id });
  if (row === undefined) {
    throw new Error('user insert failed');
  }
  return row.id;
}

async function login(app: FastifyInstance, username: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username, password },
  });
  const header = String(response.headers['set-cookie'] ?? '');
  const session = /ssd_session=([^;]+)/.exec(header)?.[1];
  if (session === undefined) {
    throw new Error('login did not set a session cookie');
  }
  return `ssd_session=${session}`;
}

function writeHeaders(cookie: string): { cookie: string; origin: string } {
  return { cookie, origin };
}

function publish(
  app: FastifyInstance,
  cookie: string,
  id: string,
  updatedAt: Date | string,
  extra: Record<string, boolean> = {},
) {
  const stamp = updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt;
  return app.inject({
    method: 'POST',
    url: `/api/admin/deals/${id}/publish`,
    headers: writeHeaders(cookie),
    payload: { updatedAt: stamp, ...extra },
  });
}

async function seedProduct(asin: string) {
  const tagged = `https://www.amazon.in/dp/${asin}?tag=example-21`;
  const [product] = await database()
    .insert(products)
    .values({ source: 'amazon', externalId: asin, canonicalUrl: tagged, title: asin })
    .returning();
  if (product === undefined) {
    throw new Error('product insert failed');
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
    throw new Error('link insert failed');
  }
  return { product, link };
}

async function seedApproved(
  asin: string,
  title: string,
  pricePaise: number,
  extra: {
    imagePath?: string;
    imageMime?: string;
    caption?: string;
    previewEnabled?: boolean;
    status?: DealStatus;
  } = {},
) {
  const { product, link } = await seedProduct(asin);
  return seedOnProduct(product.id, link.id, title, pricePaise, extra);
}

async function seedOnProduct(
  productId: string,
  linkId: string,
  title: string,
  pricePaise: number,
  extra: {
    imagePath?: string;
    imageMime?: string;
    caption?: string;
    previewEnabled?: boolean;
    status?: DealStatus;
  } = {},
) {
  const [deal] = await database()
    .insert(deals)
    .values({
      productId,
      linkId,
      status: extra.status ?? 'approved',
      title,
      pricePaise,
      highlights: [],
      previewEnabled: extra.previewEnabled ?? true,
      createdBy: graceId,
      imagePath: extra.imagePath ?? null,
      imageMime: extra.imageMime ?? null,
    })
    .returning();
  if (deal === undefined) {
    throw new Error('deal insert failed');
  }
  await database()
    .insert(contentDrafts)
    .values({
      dealId: deal.id,
      version: 1,
      bodyHtml: extra.caption ?? `<b>${title}</b>`,
      source: 'template',
      isCurrent: true,
    });
  return deal;
}

async function seedHistory(
  productId: string,
  linkId: string,
  pricePaise: number,
  postedPricePaise: number | null,
) {
  const deal = await seedOnProduct(productId, linkId, 'Earlier', pricePaise, {
    status: 'published',
  });
  const [draft] = await database()
    .select({ id: contentDrafts.id })
    .from(contentDrafts)
    .where(eq(contentDrafts.dealId, deal.id));
  const [channel] = await database()
    .insert(channels)
    .values({
      platform: 'telegram',
      name: `@old${productId.slice(0, 6)}`,
      username: `@old${productId.slice(0, 8)}`,
      isActive: true,
    })
    .returning();
  if (draft === undefined || channel === undefined) {
    throw new Error('history seed failed');
  }
  await database().insert(publications).values({
    dealId: deal.id,
    productId,
    channelId: channel.id,
    contentDraftId: draft.id,
    status: 'published',
    mode: 'text',
    linkKind: 'tagged',
    origin: 'app',
    postedPricePaise,
    attempts: 1,
    publishedAt: new Date(),
  });
}

async function seedPublishedToday(asin: string, pricePaise: number) {
  const { product, link } = await seedProduct(asin);
  await seedHistory(product.id, link.id, pricePaise, pricePaise);
}
