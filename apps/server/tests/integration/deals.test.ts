import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import * as schema from '../../src/db/schema/index.js';
import {
  affiliateLinks,
  auditLog,
  channels,
  contentDrafts,
  deals,
  priceSnapshots,
  products,
  publications,
  users,
} from '../../src/db/schema/index.js';
import { CSRF_ERROR, SIGN_IN_REQUIRED } from '../../src/modules/auth/messages.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { createWindowLimiter } from '../../src/modules/deals/rate-limit.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);
const origin = 'http://localhost:3001';
const password = 'correct-horse-battery';
const hour = 60 * 60 * 1000;

if (databaseUrl === '') {
  console.info(
    'Deal integration tests skipped: set TEST_DATABASE_URL to a database whose name ends with _test.',
  );
} else {
  assertTestDatabaseName(databaseUrl);
}

type Database = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Database | undefined;
let uploadDir = '';
let passwordHash = '';
let adaId = '';
let graceId = '';
let linusId = '';

function assertTestDatabaseName(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(
      'Refusing to run deal integration tests: TEST_DATABASE_URL is not a valid URL.',
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run deal integration tests: database name "${databaseName || '(empty)'}" must end with "_test".`,
    );
  }
}

function database(): Database {
  if (db === undefined) {
    throw new Error('deal integration database is not connected');
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

async function insertUser(username: string, role: 'owner' | 'clerk'): Promise<string> {
  const [row] = await database()
    .insert(users)
    .values({ username, role, isActive: true, passwordHash })
    .returning({ id: users.id });
  if (row === undefined) {
    throw new Error('user insert failed');
  }
  return row.id;
}

function dealBody(overrides: Record<string, unknown> = {}) {
  return {
    productUrl: 'https://www.amazon.in/dp/B0TEST1234',
    title: 'Blue kettle',
    price: '₹1,499',
    oldPrice: '2,000',
    offer: 'Bank offer',
    highlights: ['Steel', '1.5 L'],
    shortLink: 'https://amzn.to/kettle1',
    sourceNote: 'Deals group',
    clerkNotes: 'Looks good',
    ...overrides,
  };
}

function multipartBody(file: Buffer, filename: string, type: string) {
  const boundary = '----ssdealsboundary';
  return {
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function seedPublished(
  asin: string,
  postedPricePaise: number | null,
  createdBy: string,
): Promise<void> {
  const tagged = `https://www.amazon.in/dp/${asin}?tag=example-21`;
  const [product] = await database()
    .insert(products)
    .values({ source: 'amazon', externalId: asin, canonicalUrl: tagged, title: 'Old kettle' })
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
      affiliateTag: 'example-21',
      verification: 'tag_appended',
      validationStatus: 'structure_ok',
      createdBy,
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
      status: 'published',
      title: 'Old kettle',
      pricePaise: postedPricePaise ?? 100,
      oldPriceVerified: false,
      highlights: [],
      createdBy,
    })
    .returning();
  if (deal === undefined) {
    throw new Error('deal seed failed');
  }
  const [draft] = await database()
    .insert(contentDrafts)
    .values({
      dealId: deal.id,
      version: 1,
      bodyHtml: '<b>Old</b>',
      source: 'manual_edit',
      isCurrent: true,
    })
    .returning();
  if (draft === undefined) {
    throw new Error('content seed failed');
  }
  const [channel] = await database()
    .insert(channels)
    .values({
      platform: 'telegram',
      name: 'Deals',
      username: `deals-${asin.toLowerCase()}`,
      isActive: true,
    })
    .returning();
  if (channel === undefined) {
    throw new Error('channel seed failed');
  }
  await database()
    .insert(publications)
    .values({
      dealId: deal.id,
      productId: product.id,
      channelId: channel.id,
      contentDraftId: draft.id,
      status: 'published',
      postedPricePaise,
      publishedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
}

describe.skipIf(databaseUrl === '')('deal http', () => {
  let app: FastifyInstance | undefined;

  function server(): FastifyInstance {
    if (app === undefined) {
      throw new Error('deal test app is not built');
    }
    return app;
  }

  function buildTestApp(limits: { drafts?: number; uploads?: number } = {}): FastifyInstance {
    return buildApp({
      checkDb: async () => true,
      auth: {
        db: database(),
        cookieName: 'ssd_session',
        cookieSecure: false,
        allowedOrigins: [origin],
        failureDelayMs: 0,
      },
      deals: {
        amazonTag: 'example-21',
        shortLinkHosts: ['amzn.to', 'link.amazon'],
        uploadDir,
        maxUploadBytes: 4_096,
        draftLimiter: createWindowLimiter({ limit: limits.drafts ?? 30, windowMs: hour }),
        uploadLimiter: createWindowLimiter({ limit: limits.uploads ?? 30, windowMs: hour }),
      },
    });
  }

  beforeAll(async () => {
    uploadDir = await mkdtemp(path.join(tmpdir(), 'ss-deals-uploads-'));
    passwordHash = await hashPassword(password);
    pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000, max: 5 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
  });

  beforeEach(async () => {
    await truncate();
    adaId = await insertUser('ada', 'owner');
    graceId = await insertUser('grace', 'clerk');
    linusId = await insertUser('linus', 'clerk');
    await app?.close();
    app = buildTestApp();
    const names = await readdir(uploadDir);
    await Promise.all(names.map((name) => rm(path.join(uploadDir, name), { force: true })));
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await rm(uploadDir, { recursive: true, force: true });
  });

  async function login(username: string) {
    const response = await server().inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { username, password },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const token = /ssd_session=([^;]+)/.exec(header)?.[1];
    if (token === undefined) {
      throw new Error('login did not set a session cookie');
    }
    return `ssd_session=${token}`;
  }

  function postDeal(cookie: string, body: Record<string, unknown>, withOrigin = true) {
    return server().inject({
      method: 'POST',
      url: '/api/deals',
      headers: withOrigin ? { cookie, origin } : { cookie },
      payload: body,
    });
  }

  function patchDeal(cookie: string, id: string, body: Record<string, unknown>) {
    return server().inject({
      method: 'PATCH',
      url: `/api/deals/${id}`,
      headers: { cookie, origin },
      payload: body,
    });
  }

  function submitDeal(cookie: string, id: string) {
    return server().inject({
      method: 'POST',
      url: `/api/deals/${id}/submit`,
      headers: { cookie, origin },
    });
  }

  function checkUrl(cookie: string, body: Record<string, unknown>) {
    return server().inject({
      method: 'POST',
      url: '/api/deals/check-url',
      headers: { cookie, origin },
      payload: body,
    });
  }

  async function png(red: number): Promise<Buffer> {
    return sharp({
      create: { width: 12, height: 12, channels: 3, background: { r: red, g: 10, b: 20 } },
    })
      .png()
      .toBuffer();
  }

  it('creates a draft with a tagged link, paise, and verified left false', async () => {
    const cookie = await login('grace');
    const created = await postDeal(cookie, dealBody());
    expect(created.statusCode).toBe(201);
    const id = created.json().deal.id as string;
    expect(created.json().deal).toMatchObject({
      status: 'draft',
      title: 'Blue kettle',
      pricePaise: 149_900,
      oldPricePaise: 200_000,
      oldPriceVerified: false,
      highlights: ['Steel', '1.5 L'],
      offer: 'Bank offer',
      sourceNote: 'Deals group',
      clerkNotes: 'Looks good',
      taggedUrl: 'https://www.amazon.in/dp/B0TEST1234?tag=example-21',
      shortLink: 'https://amzn.to/kettle1',
    });

    const [deal] = await database().select().from(deals);
    const [product] = await database().select().from(products);
    const [link] = await database().select().from(affiliateLinks);
    expect(deal).toMatchObject({
      id,
      status: 'draft',
      pricePaise: 149_900,
      oldPriceVerified: false,
      createdBy: graceId,
    });
    expect(product).toMatchObject({
      source: 'amazon',
      externalId: 'B0TEST1234',
      title: 'Blue kettle',
    });
    expect(link).toMatchObject({
      verification: 'tag_appended',
      validationStatus: 'structure_ok',
      affiliateTag: 'example-21',
      affiliateUrl: 'https://www.amazon.in/dp/B0TEST1234?tag=example-21',
      shortUrl: 'https://amzn.to/kettle1',
    });

    const [audit] = await database().select().from(auditLog);
    expect(audit).toMatchObject({ action: 'deal.create', actorUserId: graceId, entityId: id });
    expect(JSON.stringify(audit?.details)).not.toContain('Looks good');
  });

  it('rejects a second active deal and a title that is too long', async () => {
    const cookie = await login('grace');
    expect((await postDeal(cookie, dealBody())).statusCode).toBe(201);
    const again = await postDeal(cookie, dealBody({ title: 'Changed' }));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already in the queue/i);
    const rows = await database().select().from(deals);
    expect(rows).toHaveLength(1);
    const [product] = await database().select().from(products);
    expect(product?.title).toBe('Blue kettle');

    const tooLong = await postDeal(
      cookie,
      dealBody({ title: 'a'.repeat(201), productUrl: 'https://www.amazon.in/dp/B0TEST5678' }),
    );
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().fields.title).toMatch(/200/);
  });

  it('applies the repost rule from the last published price', async () => {
    await seedPublished('B0TEST1234', 200_000, adaId);
    const cookie = await login('grace');
    const lower = await postDeal(cookie, dealBody({ price: '1999', oldPrice: '' }));
    expect(lower.statusCode).toBe(201);
    expect(lower.json().deal.title).toBe('Blue kettle');
    const stored = await database()
      .select({ id: deals.id, title: deals.title, status: deals.status })
      .from(deals);
    const published = stored.find((row) => row.status === 'published');
    expect(published?.title).toBe('Old kettle');
    expect(stored.find((row) => row.status === 'draft')?.title).toBe('Blue kettle');
    const [product] = await database().select({ title: products.title }).from(products);
    expect(product?.title).toBe('Blue kettle');
    const ada = await login('ada');
    const earlier = await server().inject({
      method: 'GET',
      url: `/api/deals/${published?.id}`,
      headers: { cookie: ada },
    });
    expect(earlier.statusCode).toBe(200);
    expect(earlier.json().deal.title).toBe('Old kettle');

    await truncate();
    adaId = await insertUser('ada', 'owner');
    graceId = await insertUser('grace', 'clerk');
    await seedPublished('B0TEST1234', 200_000, adaId);
    const equal = await postDeal(await login('grace'), dealBody({ price: '2000', oldPrice: '' }));
    expect(equal.statusCode).toBe(409);
    expect(equal.json().error).toMatch(/lower/i);

    await truncate();
    adaId = await insertUser('ada', 'owner');
    graceId = await insertUser('grace', 'clerk');
    await seedPublished('B0TEST1234', 200_000, adaId);
    const higher = await postDeal(await login('grace'), dealBody({ price: '2001', oldPrice: '' }));
    expect(higher.statusCode).toBe(409);

    await truncate();
    adaId = await insertUser('ada', 'owner');
    graceId = await insertUser('grace', 'clerk');
    await seedPublished('B0TEST1234', null, adaId);
    const unknown = await postDeal(await login('grace'), dealBody({ price: '100', oldPrice: '' }));
    expect(unknown.statusCode).toBe(409);
    expect(String(unknown.json().error).toLowerCase()).toMatch(/admin/);
    expect(String(unknown.json().error).toLowerCase()).not.toMatch(/owner|clerk/);
  });

  it('lets an admin create a draft when the earlier posted price is missing', async () => {
    await seedPublished('B0TEST1234', null, adaId);
    const body = dealBody({ price: '100', oldPrice: '', confirmUnknownPrice: true });
    const clerk = await postDeal(await login('grace'), body);
    expect(clerk.statusCode).toBe(409);
    expect(String(clerk.json().error)).toMatch(/Ask an admin/);
    expect(
      await database().select({ id: deals.id }).from(deals).where(eq(deals.status, 'draft')),
    ).toHaveLength(0);

    const admin = await login('ada');
    const without = await postDeal(admin, dealBody({ price: '100', oldPrice: '' }));
    expect(without.statusCode).toBe(409);

    const created = await postDeal(admin, body);
    expect(created.statusCode).toBe(201);
    const dealId = created.json().deal.id as string;
    const [audit] = await database()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'deal.create'), eq(auditLog.entityId, dealId)));
    expect(audit?.details).toMatchObject({ confirmUnknownPrice: true });

    await truncate();
    adaId = await insertUser('ada', 'owner');
    graceId = await insertUser('grace', 'clerk');
    await seedPublished('B0TEST5678', 200_000, adaId);
    const lower = await postDeal(
      await login('grace'),
      dealBody({
        productUrl: 'https://www.amazon.in/dp/B0TEST5678',
        price: '1999',
        oldPrice: '',
        shortLink: '',
      }),
    );
    expect(lower.statusCode).toBe(201);
  });

  it("keeps one person from reading or editing another person's deal", async () => {
    const grace = await login('grace');
    const created = await postDeal(grace, dealBody());
    const id = created.json().deal.id as string;
    const linus = await login('linus');
    expect(
      (
        await server().inject({
          method: 'GET',
          url: `/api/deals/${id}`,
          headers: { cookie: linus },
        })
      ).statusCode,
    ).toBe(404);
    expect((await patchDeal(linus, id, dealBody({ title: 'Stolen' }))).statusCode).toBe(404);

    const ada = await login('ada');
    const ownerDeal = await postDeal(
      ada,
      dealBody({ productUrl: 'https://www.amazon.in/dp/B0TEST5678', shortLink: '' }),
    );
    const ownerId = ownerDeal.json().deal.id as string;
    expect(
      (
        await server().inject({
          method: 'GET',
          url: `/api/deals/${ownerId}`,
          headers: { cookie: grace },
        })
      ).statusCode,
    ).toBe(404);
    expect((await patchDeal(grace, ownerId, dealBody())).statusCode).toBe(404);

    const ownerRead = await server().inject({
      method: 'GET',
      url: `/api/deals/${id}`,
      headers: { cookie: ada },
    });
    expect(ownerRead.statusCode).toBe(200);

    const graceList = await server().inject({
      method: 'GET',
      url: '/api/deals',
      headers: { cookie: grace },
    });
    expect(graceList.json().deals.map((deal: { id: string }) => deal.id)).toEqual([id]);
    const adaList = await server().inject({
      method: 'GET',
      url: '/api/deals',
      headers: { cookie: ada },
    });
    expect(adaList.json().deals.map((deal: { id: string }) => deal.id)).toEqual([ownerId]);
    expect(adaId).not.toBe('');
    expect(graceId).not.toBe('');
    expect(linusId).not.toBe('');
  });

  it('requires the origin header, a session, and a known status filter', async () => {
    const cookie = await login('grace');
    const blocked = await postDeal(cookie, dealBody(), false);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe(CSRF_ERROR);
    const anonymous = await server().inject({ method: 'GET', url: '/api/deals' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error).toBe(SIGN_IN_REQUIRED);
    const config = await server().inject({
      method: 'GET',
      url: '/api/deals/config',
      headers: { cookie },
    });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toEqual({
      shortLinkHosts: ['amzn.to', 'link.amazon'],
      maxUploadMb: 4_096 / (1024 * 1024),
    });
    const hidden = await server().inject({ method: 'GET', url: '/api/deals/config' });
    expect(hidden.statusCode).toBe(401);
    const badStatus = await server().inject({
      method: 'GET',
      url: '/api/deals?status=nope',
      headers: { cookie },
    });
    expect(badStatus.statusCode).toBe(400);
  });

  it('submits a draft, writes a price snapshot, and rejects illegal moves', async () => {
    const cookie = await login('grace');
    const created = await postDeal(cookie, dealBody());
    const id = created.json().deal.id as string;
    await database()
      .update(products)
      .set({ title: 'Latest catalogue name' })
      .where(eq(products.externalId, 'B0TEST1234'));
    const submitted = await submitDeal(cookie, id);
    expect(submitted.json().deal.title).toBe('Blue kettle');
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().deal.status).toBe('pending_approval');
    expect(submitted.json().deal.reviewNote).toBeNull();
    const [snapshot] = await database().select().from(priceSnapshots);
    expect(snapshot).toMatchObject({
      origin: 'clerk_entered',
      pricePaise: 149_900,
      recordedBy: graceId,
      dealId: id,
    });
    expect((await submitDeal(cookie, id)).statusCode).toBe(409);
    expect((await patchDeal(cookie, id, dealBody({ title: 'Later' }))).statusCode).toBe(409);

    const actions = (await database().select().from(auditLog)).map((row) => row.action).sort();
    expect(actions).toEqual(['deal.create', 'deal.submit']);

    const waiting = await server().inject({
      method: 'GET',
      url: '/api/deals?status=pending_approval',
      headers: { cookie },
    });
    expect(waiting.json().deals).toHaveLength(1);
    const drafts = await server().inject({
      method: 'GET',
      url: '/api/deals?status=draft',
      headers: { cookie },
    });
    expect(drafts.json().deals).toHaveLength(0);
  });

  it('returns 409 when a published deal is sent again', async () => {
    const cookie = await login('grace');
    const created = await postDeal(cookie, dealBody());
    const id = created.json().deal.id as string;
    await database().update(deals).set({ status: 'published' }).where(eq(deals.id, id));
    expect((await submitDeal(cookie, id)).statusCode).toBe(409);
  });

  it('checks a pasted link without calling the network or inserting a product', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const cookie = await login('grace');
    const before = await database().select().from(products);
    const fresh = await checkUrl(cookie, { url: 'https://www.amazon.in/dp/B0TEST9999' });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toMatchObject({ ok: true, asin: 'B0TEST9999', code: 'ok', problems: [] });
    expect(await database().select().from(products)).toHaveLength(before.length);

    const bad = await checkUrl(cookie, { url: 'https://example.com/item' });
    expect(bad.json()).toMatchObject({ ok: false, asin: null });
    expect(bad.json().problems[0]).toMatch(/amazon\.in/);

    await postDeal(cookie, dealBody());
    const queued = await checkUrl(cookie, {
      url: 'https://www.amazon.in/dp/B0TEST1234',
      price: '1499',
    });
    expect(queued.json().code).toBe('in_queue');
    const ownId = (
      await server().inject({ method: 'GET', url: '/api/deals', headers: { cookie } })
    ).json().deals[0].id as string;
    const editing = await checkUrl(cookie, {
      url: 'https://www.amazon.in/dp/B0TEST1234',
      price: '1499',
      dealId: ownId,
    });
    expect(editing.json().code).toBe('editing');
    expect(editing.json().activeDeal).toBe(false);
    const other = await checkUrl(await login('linus'), {
      url: 'https://www.amazon.in/dp/B0TEST1234',
      dealId: ownId,
    });
    expect(other.json().code).toBe('in_queue');

    await seedPublished('B0TEST5678', 200_000, adaId);
    const lower = await checkUrl(cookie, {
      url: 'https://www.amazon.in/dp/B0TEST5678',
      price: '1999',
    });
    expect(lower.json().code).toBe('posted_lower');
    expect(lower.json().repost).toEqual({ allowed: true, reason: 'price_lower' });
    const same = await checkUrl(cookie, {
      url: 'https://www.amazon.in/dp/B0TEST5678',
      price: '2000',
    });
    expect(same.json().code).toBe('posted_blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('stores a re-encoded image and refuses other people, bad files, and files that are too large', async () => {
    const cookie = await login('grace');
    const created = await postDeal(cookie, dealBody());
    const id = created.json().deal.id as string;
    const first = await png(30);
    const uploaded = await upload(cookie, id, first, 'photo.jpg', 'image/jpeg');
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().deal.hasImage).toBe(true);
    const [stored] = await database()
      .select({ imagePath: deals.imagePath, imageMime: deals.imageMime })
      .from(deals);
    expect(stored?.imageMime).toBe('image/png');
    expect(stored?.imagePath).toMatch(/^[a-f0-9]{32}\.png$/);
    expect(await exists(path.join(uploadDir, stored?.imagePath ?? ''))).toBe(true);

    const image = await server().inject({
      method: 'GET',
      url: `/api/deals/${id}/image`,
      headers: { cookie },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/png');
    expect(String(image.headers['cache-control'])).toContain('private');
    expect(String(image.headers['cache-control'])).toContain('no-cache');
    expect(image.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const firstBytes = Buffer.from(image.rawPayload);

    const linus = await login('linus');
    expect(
      (
        await server().inject({
          method: 'GET',
          url: `/api/deals/${id}/image`,
          headers: { cookie: linus },
        })
      ).statusCode,
    ).toBe(404);
    const ada = await login('ada');
    expect(
      (
        await server().inject({
          method: 'GET',
          url: `/api/deals/${id}/image`,
          headers: { cookie: ada },
        })
      ).statusCode,
    ).toBe(200);

    const renamed = await upload(
      cookie,
      id,
      Buffer.from('this is not an image'),
      'photo.jpg',
      'image/jpeg',
    );
    expect(renamed.statusCode).toBe(400);
    expect(renamed.json().error).toMatch(/JPEG|PNG|WebP/);

    const oversized = await upload(cookie, id, Buffer.alloc(8_000, 7), 'big.png', 'image/png');
    expect(oversized.statusCode).toBe(413);

    const second = await upload(cookie, id, await png(200), 'next.png', 'image/png');
    expect(second.statusCode).toBe(200);
    const [replaced] = await database().select({ imagePath: deals.imagePath }).from(deals);
    expect(replaced?.imagePath).not.toBe(stored?.imagePath);
    expect(await exists(path.join(uploadDir, stored?.imagePath ?? ''))).toBe(false);
    expect(await exists(path.join(uploadDir, replaced?.imagePath ?? ''))).toBe(true);
    const replacedFile = await readFile(path.join(uploadDir, replaced?.imagePath ?? ''));
    const replacedImage = await server().inject({
      method: 'GET',
      url: `/api/deals/${id}/image?v=${encodeURIComponent(second.json().deal.updatedAt as string)}`,
      headers: { cookie },
    });
    expect(replacedImage.statusCode).toBe(200);
    expect(String(replacedImage.headers['cache-control'])).toContain('no-cache');
    expect(Buffer.compare(replacedImage.rawPayload, replacedFile)).toBe(0);
    expect(Buffer.compare(replacedImage.rawPayload, firstBytes)).not.toBe(0);

    const removed = await server().inject({
      method: 'DELETE',
      url: `/api/deals/${id}/image`,
      headers: { cookie, origin },
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await server().inject({ method: 'GET', url: `/api/deals/${id}/image`, headers: { cookie } }))
        .statusCode,
    ).toBe(404);

    const actions = (await database().select().from(auditLog)).map((row) => row.action);
    expect(actions).toContain('deal.image_upload');
    expect(actions).toContain('deal.image_remove');
  });

  it('limits how many drafts and uploads one person can make in an hour', async () => {
    await app?.close();
    app = buildTestApp({ drafts: 2, uploads: 1 });
    const cookie = await login('grace');
    expect(
      (
        await postDeal(
          cookie,
          dealBody({ productUrl: 'https://www.amazon.in/dp/B0RATE0001', shortLink: '' }),
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await postDeal(
          cookie,
          dealBody({ productUrl: 'https://www.amazon.in/dp/B0RATE0002', shortLink: '' }),
        )
      ).statusCode,
    ).toBe(201);
    const blocked = await postDeal(
      cookie,
      dealBody({ productUrl: 'https://www.amazon.in/dp/B0RATE0003', shortLink: '' }),
    );
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    const created = await server().inject({
      method: 'GET',
      url: '/api/deals',
      headers: { cookie },
    });
    const id = created.json().deals[0].id as string;
    expect((await upload(cookie, id, await png(1), 'a.png', 'image/png')).statusCode).toBe(200);
    expect((await upload(cookie, id, await png(2), 'b.png', 'image/png')).statusCode).toBe(429);
  });

  function withdrawDeal(cookie: string, id: string) {
    return server().inject({
      method: 'POST',
      url: `/api/deals/${id}/withdraw`,
      headers: { cookie, origin },
    });
  }

  it('withdraws a deal that is waiting for review and lets the creator send it again', async () => {
    const grace = await login('grace');
    const created = await postDeal(grace, dealBody());
    const id = created.json().deal.id as string;
    expect(created.json().deal.editable).toBe(true);
    expect((await withdrawDeal(grace, id)).statusCode).toBe(409);

    const submitted = await submitDeal(grace, id);
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json().deal.editable).toBe(false);
    const linus = await login('linus');
    expect((await withdrawDeal(linus, id)).statusCode).toBe(404);
    expect((await patchDeal(linus, id, dealBody({ title: 'Stolen' }))).statusCode).toBe(404);
    const ada = await login('ada');
    expect((await withdrawDeal(ada, id)).statusCode).toBe(403);
    expect((await patchDeal(ada, id, dealBody({ title: 'Stolen' }))).statusCode).toBe(403);

    const withdrawn = await withdrawDeal(grace, id);
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().deal.status).toBe('draft');
    expect(withdrawn.json().deal.editable).toBe(true);
    const actions = (await database().select().from(auditLog)).map((row) => row.action);
    expect(actions).toContain('deal.withdraw');

    const edited = await patchDeal(grace, id, dealBody({ title: 'Blue kettle revised' }));
    expect(edited.statusCode).toBe(200);
    expect(edited.json().deal.title).toBe('Blue kettle revised');
    const again = await submitDeal(grace, id);
    expect(again.statusCode).toBe(200);
    expect(again.json().deal.status).toBe('pending_approval');
    expect((await withdrawDeal(grace, id)).statusCode).toBe(200);
    await database().update(deals).set({ status: 'approved' }).where(eq(deals.id, id));
    expect((await withdrawDeal(grace, id)).statusCode).toBe(409);
    expect((await withdrawDeal(grace, id)).json().error).toBe('This deal was already reviewed.');
  });

  it("still applies the repost rule when editing the creator's own deal", async () => {
    await seedPublished('B0TEST1234', 200_000, adaId);
    const grace = await login('grace');
    const created = await postDeal(grace, dealBody({ price: '1499', oldPrice: '' }));
    expect(created.statusCode).toBe(201);
    const id = created.json().deal.id as string;
    const lower = await checkUrl(grace, {
      url: 'https://www.amazon.in/dp/B0TEST1234',
      price: '1499',
      dealId: id,
    });
    expect(lower.json().code).toBe('posted_lower');
    const blocked = await checkUrl(grace, {
      url: 'https://www.amazon.in/dp/B0TEST1234',
      price: '2000',
      dealId: id,
    });
    expect(blocked.json().code).toBe('posted_blocked');
    const other = await checkUrl(await login('linus'), {
      url: 'https://www.amazon.in/dp/B0TEST1234',
      price: '1000',
      dealId: id,
    });
    expect(other.json().code).toBe('in_queue');
    expect((await patchDeal(grace, id, dealBody({ price: '2000', oldPrice: '' }))).statusCode).toBe(
      409,
    );
    expect((await patchDeal(grace, id, dealBody({ price: '1499', oldPrice: '' }))).statusCode).toBe(
      200,
    );
  });

  it('shares earlier published details and copies only the image', async () => {
    await seedPublished('B0PREV0001', 250_000, adaId);
    const [source] = await database()
      .select({ id: deals.id, linkId: deals.linkId })
      .from(deals)
      .innerJoin(products, eq(products.id, deals.productId))
      .where(eq(products.externalId, 'B0PREV0001'));
    if (source === undefined) {
      throw new Error('published deal missing');
    }
    await database()
      .update(deals)
      .set({
        title: 'Earlier kettle',
        highlights: ['Steel'],
        sourceNote: 'Old group',
        previewEnabled: false,
        offerText: 'Do not copy',
        oldPricePaise: 300_000,
        oldPriceVerified: true,
      })
      .where(eq(deals.id, source.id));
    await database()
      .update(affiliateLinks)
      .set({ shortUrl: 'https://amzn.to/earlier' })
      .where(eq(affiliateLinks.id, source.linkId));
    const bytes = await png(40);
    const ada = await login('ada');
    const uploaded = await upload(ada, source.id, bytes, 'earlier.png', 'image/png');
    expect(uploaded.statusCode).toBe(409);

    const { writeStoredImage } = await import('../../src/modules/uploads/files.js');
    const filename = await writeStoredImage(uploadDir, 'png', bytes);
    await database()
      .update(deals)
      .set({ imagePath: filename, imageMime: 'image/png' })
      .where(eq(deals.id, source.id));

    const grace = await login('grace');
    const earlier = await server().inject({
      method: 'GET',
      url: '/api/deals/previous?asin=B0PREV0001',
      headers: { cookie: grace, origin },
    });
    expect(earlier.statusCode).toBe(200);
    expect(earlier.json()).toMatchObject({
      dealId: source.id,
      title: 'Earlier kettle',
      highlights: ['Steel'],
      shortLink: 'https://amzn.to/earlier',
      sourceNote: 'Old group',
      previewEnabled: false,
      hasImage: true,
      postedPrice: 250_000,
    });
    expect(earlier.json()).not.toHaveProperty('offer');
    expect(earlier.json()).not.toHaveProperty('oldPricePaise');
    expect(earlier.json()).not.toHaveProperty('oldPriceVerified');

    const created = await postDeal(
      grace,
      dealBody({
        productUrl: 'https://www.amazon.in/dp/B0PREV0001',
        price: '1999',
        oldPrice: '2500',
        offer: 'Mine',
      }),
    );
    expect(created.statusCode).toBe(201);
    const id = created.json().deal.id as string;
    expect(created.json().deal.pricePaise).toBe(199_900);
    const copied = await server().inject({
      method: 'POST',
      url: `/api/deals/${id}/image/copy-from/${source.id}`,
      headers: { cookie: grace, origin },
    });
    expect(copied.statusCode).toBe(200);
    expect(copied.json().deal.hasImage).toBe(true);
    expect(copied.json().deal.pricePaise).toBe(199_900);
    expect(copied.json().deal.offer).toBe('Mine');
    expect(copied.json().deal.oldPriceVerified).toBe(false);
    expect(copied.json().deal.imagePath).toBeUndefined();

    const privateDraft = await postDeal(
      ada,
      dealBody({ productUrl: 'https://www.amazon.in/dp/B0PRIV0001' }),
    );
    expect(privateDraft.statusCode).toBe(201);
    const privateId = privateDraft.json().deal.id as string;
    await upload(ada, privateId, await png(12), 'private.png', 'image/png');
    expect(
      (
        await server().inject({
          method: 'GET',
          url: '/api/deals/previous?asin=B0PRIV0001',
          headers: { cookie: grace, origin },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server().inject({
          method: 'POST',
          url: `/api/deals/${id}/image/copy-from/${privateId}`,
          headers: { cookie: grace, origin },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await server().inject({
          method: 'GET',
          url: '/api/deals/previous?asin=B0PRIV0001',
          headers: { cookie: ada, origin },
        })
      ).statusCode,
    ).toBe(200);
  });

  function upload(cookie: string, id: string, file: Buffer, filename: string, type: string) {
    const body = multipartBody(file, filename, type);
    return server().inject({
      method: 'POST',
      url: `/api/deals/${id}/image`,
      headers: { cookie, origin, 'content-type': body.contentType },
      payload: body.payload,
    });
  }
});
