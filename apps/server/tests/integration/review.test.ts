import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { FORBIDDEN_ERROR, SIGN_IN_REQUIRED } from '../../src/modules/auth/messages.js';
import { NOT_EDITABLE, repostRefusalMessage } from '../../src/modules/deals/messages.js';
import {
  NOTE_REQUIRED,
  REASON_REQUIRED,
  STALE_DEAL,
  WITHDRAWN_DEAL,
} from '../../src/modules/review/messages.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import type { DealStatus } from '../../src/modules/deals/status.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);
const origin = 'http://localhost:3001';
const password = 'correct-horse-battery';

if (databaseUrl === '') {
  console.info(
    'Review integration tests skipped: set TEST_DATABASE_URL to a database whose name ends with _test.',
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
      'Refusing to run review integration tests: TEST_DATABASE_URL is not a valid URL.',
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run review integration tests: database name "${databaseName || '(empty)'}" must end with "_test".`,
    );
  }
}

function database(): Database {
  if (db === undefined) {
    throw new Error('review integration database is not connected');
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
  displayName?: string,
): Promise<string> {
  const [row] = await database()
    .insert(users)
    .values({ username, role, displayName: displayName ?? null, isActive: true, passwordHash })
    .returning({ id: users.id });
  if (row === undefined) {
    throw new Error('user insert failed');
  }
  return row.id;
}

async function seedProductAndLink(asin: string, createdBy: string) {
  const tagged = `https://www.amazon.in/dp/${asin}?tag=example-21`;
  const [existingProduct] = await database()
    .select()
    .from(products)
    .where(and(eq(products.source, 'amazon'), eq(products.externalId, asin)))
    .limit(1);

  const product =
    existingProduct ??
    (
      await database()
        .insert(products)
        .values({
          source: 'amazon',
          externalId: asin,
          canonicalUrl: tagged,
          title: `Product ${asin}`,
        })
        .returning()
    )[0];
  if (product === undefined) {
    throw new Error('product seed failed');
  }

  const [existingLink] = await database()
    .select()
    .from(affiliateLinks)
    .where(eq(affiliateLinks.productId, product.id))
    .limit(1);

  const link =
    existingLink ??
    (
      await database()
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
          createdBy,
        })
        .returning()
    )[0];
  if (link === undefined) {
    throw new Error('link seed failed');
  }
  return { product, link };
}

async function seedDeal(input: {
  asin: string;
  createdBy: string;
  status: DealStatus;
  title: string;
  pricePaise: number;
  oldPricePaise?: number | null;
  oldPriceVerified?: boolean;
  highlights?: string[];
  offerText?: string | null;
  sourceNote?: string | null;
  clerkNotes?: string | null;
  reviewNote?: string | null;
  rejectedReason?: string | null;
  submittedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  const { product, link } = await seedProductAndLink(input.asin, input.createdBy);
  const [deal] = await database()
    .insert(deals)
    .values({
      productId: product.id,
      linkId: link.id,
      status: input.status,
      title: input.title,
      pricePaise: input.pricePaise,
      oldPricePaise: input.oldPricePaise ?? null,
      oldPriceVerified: input.oldPriceVerified ?? false,
      highlights: input.highlights ?? [],
      offerText: input.offerText ?? null,
      sourceNote: input.sourceNote ?? null,
      clerkNotes: input.clerkNotes ?? null,
      reviewNote: input.reviewNote ?? null,
      rejectedReason: input.rejectedReason ?? null,
      createdBy: input.createdBy,
      submittedAt: input.submittedAt ?? null,
      createdAt: input.createdAt ?? new Date(),
      updatedAt: input.updatedAt ?? new Date(),
    })
    .returning();
  if (deal === undefined) {
    throw new Error('deal seed failed');
  }
  return { deal, product, link };
}

async function seedPublished(
  asin: string,
  postedPricePaise: number | null,
  createdBy: string,
): Promise<{ productId: string }> {
  const { deal, product } = await seedDeal({
    asin,
    createdBy,
    status: 'published',
    title: `Published item ${asin}`,
    pricePaise: postedPricePaise ?? 10000,
  });

  const [draft] = await database()
    .insert(contentDrafts)
    .values({
      dealId: deal.id,
      version: 1,
      bodyHtml: '<b>Published</b>',
      source: 'manual_edit',
      isCurrent: true,
    })
    .returning();
  if (draft === undefined) {
    throw new Error('draft seed failed');
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

  return { productId: product.id };
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

async function png(red: number): Promise<Buffer> {
  return sharp({
    create: { width: 12, height: 12, channels: 3, background: { r: red, g: 10, b: 20 } },
  })
    .png()
    .toBuffer();
}

describe.skipIf(databaseUrl === '')('admin review http api', () => {
  let app: FastifyInstance | undefined;

  function server(): FastifyInstance {
    if (app === undefined) {
      throw new Error('review test app is not built');
    }
    return app;
  }

  beforeAll(async () => {
    uploadDir = await mkdtemp(path.join(tmpdir(), 'ss-deals-review-uploads-'));
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
      },
      deals: {
        amazonTag: 'example-21',
        shortLinkHosts: ['amzn.to', 'link.amazon'],
        uploadDir,
        maxUploadBytes: 4_096,
      },
    });
  });

  beforeEach(async () => {
    await truncate();
    adaId = await insertUser('ada', 'owner', 'Ada Lovelace');
    graceId = await insertUser('grace', 'clerk', 'Grace Hopper');
    linusId = await insertUser('linus', 'clerk');
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

  it('rejects unauthenticated requests with 401 and non-admins with 403', async () => {
    const anonList = await server().inject({
      method: 'GET',
      url: '/api/admin/deals',
    });
    expect(anonList.statusCode).toBe(401);
    expect(anonList.json()).toEqual({ error: SIGN_IN_REQUIRED });

    const anonDetail = await server().inject({
      method: 'GET',
      url: '/api/admin/deals/00000000-0000-0000-0000-000000000000',
    });
    expect(anonDetail.statusCode).toBe(401);
    expect(anonDetail.json()).toEqual({ error: SIGN_IN_REQUIRED });

    const clerkCookie = await login('grace');

    const clerkList = await server().inject({
      method: 'GET',
      url: '/api/admin/deals',
      headers: { cookie: clerkCookie },
    });
    expect(clerkList.statusCode).toBe(403);
    expect(clerkList.json()).toEqual({ error: FORBIDDEN_ERROR });

    const clerkDetail = await server().inject({
      method: 'GET',
      url: '/api/admin/deals/00000000-0000-0000-0000-000000000000',
      headers: { cookie: clerkCookie },
    });
    expect(clerkDetail.statusCode).toBe(403);
    expect(clerkDetail.json()).toEqual({ error: FORBIDDEN_ERROR });
    expect(adaId).not.toBe('');
  });

  it('returns status counts matching the database and defaults to pending_approval', async () => {
    const adminCookie = await login('ada');

    await seedDeal({
      asin: 'B0PEND0001',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Pending One',
      pricePaise: 100000,
      submittedAt: new Date('2026-11-01T10:00:00Z'),
    });
    await seedDeal({
      asin: 'B0PEND0002',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Pending Two',
      pricePaise: 150000,
      submittedAt: new Date('2026-11-01T11:00:00Z'),
    });
    await seedDeal({
      asin: 'B0APPR0001',
      createdBy: linusId,
      status: 'approved',
      title: 'Approved One',
      pricePaise: 200000,
    });
    await seedDeal({
      asin: 'B0DRAF0001',
      createdBy: graceId,
      status: 'draft',
      title: 'Draft One',
      pricePaise: 50000,
    });
    await seedDeal({
      asin: 'B0DRAF0002',
      createdBy: linusId,
      status: 'draft',
      title: 'Draft Two',
      pricePaise: 75000,
    });
    await seedDeal({
      asin: 'B0REJT0001',
      createdBy: graceId,
      status: 'rejected',
      title: 'Rejected One',
      pricePaise: 90000,
    });
    await seedDeal({
      asin: 'B0FAIL0001',
      createdBy: linusId,
      status: 'failed',
      title: 'Failed One',
      pricePaise: 80000,
    });
    await seedDeal({
      asin: 'B0PUBL0001',
      createdBy: graceId,
      status: 'published',
      title: 'Published One',
      pricePaise: 120000,
    });

    const res = await server().inject({
      method: 'GET',
      url: '/api/admin/deals',
      headers: { cookie: adminCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.counts).toEqual({
      pending_approval: 2,
      approved: 1,
      draft: 2,
      rejected: 1,
      published: 1,
      failed: 1,
      scheduled: 0,
      sent_back: 0,
    });

    // Default status filter is pending_approval
    expect(body.items.length).toBe(2);
    expect(body.items.map((item: { title: string }) => item.title)).toEqual([
      'Pending One',
      'Pending Two',
    ]);

    // Check item shape and rupee conversion
    const item = body.items[0];
    expect(item).toMatchObject({
      title: 'Pending One',
      price: 1000,
      oldPrice: null,
      oldPriceVerified: false,
      hasImage: false,
      createdBy: 'Grace Hopper',
      status: 'pending_approval',
    });
    expect(item.id).toBeDefined();
    expect(item.submittedAt).toBeDefined();
    expect(item.updatedAt).toBeDefined();
  });

  it('filters by status and supports pagination', async () => {
    const adminCookie = await login('ada');

    for (let i = 1; i <= 5; i += 1) {
      await seedDeal({
        asin: `B0PAGETEST${i}`,
        createdBy: linusId,
        status: 'draft',
        title: `Draft Deal ${i}`,
        pricePaise: i * 10000,
      });
    }

    const invalidStatus = await server().inject({
      method: 'GET',
      url: '/api/admin/deals?status=nonexistent',
      headers: { cookie: adminCookie },
    });
    expect(invalidStatus.statusCode).toBe(400);

    const page1 = await server().inject({
      method: 'GET',
      url: '/api/admin/deals?status=draft&page=1&pageSize=2',
      headers: { cookie: adminCookie },
    });
    expect(page1.statusCode).toBe(200);
    const page1Body = page1.json();
    expect(page1Body.items.length).toBe(2);

    const page2 = await server().inject({
      method: 'GET',
      url: '/api/admin/deals?status=draft&page=2&pageSize=2',
      headers: { cookie: adminCookie },
    });
    expect(page2.statusCode).toBe(200);
    const page2Body = page2.json();
    expect(page2Body.items.length).toBe(2);
    expect(page2Body.items[0].id).not.toBe(page1Body.items[0].id);
    expect(page2Body.items[0].id).not.toBe(page1Body.items[1].id);

    const page3 = await server().inject({
      method: 'GET',
      url: '/api/admin/deals?status=draft&page=3&pageSize=2',
      headers: { cookie: adminCookie },
    });
    expect(page3.statusCode).toBe(200);
    expect(page3.json().items.length).toBe(1);

    // PageSize max 50: requesting 100 clamps to 50 without error
    const clamped = await server().inject({
      method: 'GET',
      url: '/api/admin/deals?status=draft&page=1&pageSize=100',
      headers: { cookie: adminCookie },
    });
    expect(clamped.statusCode).toBe(200);
    expect(clamped.json().items.length).toBe(5);
  });

  it('orders pending_approval oldest first and other statuses newest first', async () => {
    const adminCookie = await login('ada');

    // Pending approval: oldest submitted first
    const earlyDate = new Date('2026-11-01T08:00:00Z');
    const lateDate = new Date('2026-11-01T12:00:00Z');

    await seedDeal({
      asin: 'B0ORDERP1',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Later Submission',
      pricePaise: 100000,
      submittedAt: lateDate,
      createdAt: lateDate,
    });
    await seedDeal({
      asin: 'B0ORDERP2',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Earlier Submission',
      pricePaise: 100000,
      submittedAt: earlyDate,
      createdAt: earlyDate,
    });

    const pendingRes = await server().inject({
      method: 'GET',
      url: '/api/admin/deals?status=pending_approval',
      headers: { cookie: adminCookie },
    });
    expect(pendingRes.statusCode).toBe(200);
    const pendingTitles = pendingRes.json().items.map((item: { title: string }) => item.title);
    expect(pendingTitles).toEqual(['Earlier Submission', 'Later Submission']);

    // Other statuses (draft): newest first
    const d1Time = new Date('2026-11-01T07:00:00Z');
    const d2Time = new Date('2026-11-01T14:00:00Z');

    await seedDeal({
      asin: 'B0ORDERD1',
      createdBy: graceId,
      status: 'draft',
      title: 'Older Draft',
      pricePaise: 50000,
      createdAt: d1Time,
      updatedAt: d1Time,
    });
    await seedDeal({
      asin: 'B0ORDERD2',
      createdBy: graceId,
      status: 'draft',
      title: 'Newer Draft',
      pricePaise: 60000,
      createdAt: d2Time,
      updatedAt: d2Time,
    });

    const draftRes = await server().inject({
      method: 'GET',
      url: '/api/admin/deals?status=draft',
      headers: { cookie: adminCookie },
    });
    expect(draftRes.statusCode).toBe(200);
    const draftTitles = draftRes.json().items.map((item: { title: string }) => item.title);
    expect(draftTitles).toEqual(['Newer Draft', 'Older Draft']);
  });

  it('returns deal detail with preview, character count, forbidden words, and duplicate repost info', async () => {
    const adminCookie = await login('ada');

    // Seed previous publication for ASIN B0DUPL1234 at posted price ₹2,000 (200000 paise)
    await seedPublished('B0DUPL1234', 200000, graceId);

    // Now seed a deal for the same ASIN at ₹1,499 (149900 paise)
    const { deal } = await seedDeal({
      asin: 'B0DUPL1234',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Hurry! Super Stainless Steel Kettle',
      pricePaise: 149900,
      oldPricePaise: 250000,
      oldPriceVerified: false,
      highlights: ['1.5L Capacity', 'Auto Shut-off'],
      offerText: 'Bank Offer 10%',
      clerkNotes: 'Good deal found on telegram',
      sourceNote: 'TG group',
      submittedAt: new Date('2026-11-02T10:00:00Z'),
    });

    const detailRes = await server().inject({
      method: 'GET',
      url: `/api/admin/deals/${deal.id}`,
      headers: { cookie: adminCookie },
    });

    expect(detailRes.statusCode).toBe(200);
    const body = detailRes.json();

    // Verify deal fields in rupees
    expect(body.id).toBe(deal.id);
    expect(body.title).toBe('Hurry! Super Stainless Steel Kettle');
    expect(body.price).toBe(1499);
    expect(body.oldPrice).toBe(2500);
    expect(body.oldPriceVerified).toBe(false);
    expect(body.asin).toBe('B0DUPL1234');
    expect(body.clerkNotes).toBe('Good deal found on telegram');
    expect(body.sourceNote).toBe('TG group');
    expect(body.createdBy).toBe('Grace Hopper');
    expect(body.submittedAt).toBeDefined();
    expect(body.updatedAt).toBeDefined();
    expect(body.taggedUrl).toContain('B0DUPL1234');

    // No private fields
    expect(body.passwordHash).toBeUndefined();
    expect(body.telegramUserId).toBeUndefined();
    expect(body.session).toBeUndefined();

    // Duplicate summary
    expect(body.duplicate.hasActiveDeal).toBe(false);
    expect(body.duplicate.repost.allowed).toBe(true);
    expect(body.duplicate.repost.reason).toBe('price_lower');
    expect(body.duplicate.previousPostedPriceRupees).toBe(2000);

    // Preview
    expect(body.preview).toBeDefined();
    expect(body.preview.ok).toBe(true);
    expect(body.preview.characterCount).toBe(body.preview.html.length);
    expect(body.preview.html).toContain('Super Stainless Steel Kettle');
    expect(body.preview.html).toContain('₹1,499');
    expect(body.preview.html).toContain('Listed at ₹2,500');
    expect(body.preview.warnings.length).toBeGreaterThan(0);
    expect(body.preview.warnings[0]).toContain('hurry');
  });

  it('reports duplicate activeDeal when another active deal exists, and price_not_lower when repost price is higher', async () => {
    const adminCookie = await login('ada');

    // Previous publication at ₹2,000 (200000 paise)
    const { productId } = await seedPublished('B0DUPL9999', 200000, graceId);

    // Active deal 1 for this product
    const { link } = await seedProductAndLink('B0DUPL9999', graceId);
    const [activeDeal] = await database()
      .insert(deals)
      .values({
        productId,
        linkId: link.id,
        status: 'pending_approval',
        title: 'Active Deal 1',
        pricePaise: 150000,
        createdBy: graceId,
      })
      .returning();
    expect(activeDeal).toBeDefined();

    // Inactive deal 2 (rejected) for same product at higher price ₹2,500 (250000 paise)
    const [rejectedDeal] = await database()
      .insert(deals)
      .values({
        productId,
        linkId: link.id,
        status: 'rejected',
        title: 'Rejected Deal 2',
        pricePaise: 250000,
        createdBy: graceId,
      })
      .returning();
    expect(activeDeal).toBeDefined();

    const detail = await server().inject({
      method: 'GET',
      url: `/api/admin/deals/${rejectedDeal!.id}`,
      headers: { cookie: adminCookie },
    });

    expect(detail.statusCode).toBe(200);
    const body = detail.json();

    // Another active deal exists (activeDeal 1)
    expect(body.duplicate.hasActiveDeal).toBe(true);
    // Repost price is higher than previous 2,000
    expect(body.duplicate.repost.allowed).toBe(false);
    expect(body.duplicate.repost.reason).toBe('price_not_lower');
  });

  it('lets an admin fetch an image of someone elses deal while a different non-admin cannot', async () => {
    const graceCookie = await login('grace');
    const linusCookie = await login('linus');
    const adaCookie = await login('ada');

    // Grace creates a draft and uploads an image
    const { deal } = await seedDeal({
      asin: 'B0IMGTEST1',
      createdBy: graceId,
      status: 'draft',
      title: 'Image Test Deal',
      pricePaise: 120000,
    });

    const file = await png(150);
    const multipart = multipartBody(file, 'deal.png', 'image/png');

    const uploadRes = await server().inject({
      method: 'POST',
      url: `/api/deals/${deal.id}/image`,
      headers: { cookie: graceCookie, origin, 'content-type': multipart.contentType },
      payload: multipart.payload,
    });
    expect(uploadRes.statusCode).toBe(200);

    // Grace (creator) can read the image
    const graceGet = await server().inject({
      method: 'GET',
      url: `/api/deals/${deal.id}/image`,
      headers: { cookie: graceCookie },
    });
    expect(graceGet.statusCode).toBe(200);
    expect(graceGet.headers['content-type']).toContain('image/png');

    // Linus (different non-admin clerk) CANNOT read Grace's deal image (404)
    const linusGet = await server().inject({
      method: 'GET',
      url: `/api/deals/${deal.id}/image`,
      headers: { cookie: linusCookie },
    });
    expect(linusGet.statusCode).toBe(404);

    // Ada (admin/owner) CAN read Grace's deal image (200)
    const adaGet = await server().inject({
      method: 'GET',
      url: `/api/deals/${deal.id}/image`,
      headers: { cookie: adaCookie },
    });
    expect(adaGet.statusCode).toBe(200);
    expect(adaGet.headers['content-type']).toContain('image/png');
    expect(adaGet.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Deal detail for Ada shows image info
    const adminDetail = await server().inject({
      method: 'GET',
      url: `/api/admin/deals/${deal.id}`,
      headers: { cookie: adaCookie },
    });
    expect(adminDetail.statusCode).toBe(200);
    expect(adminDetail.json().hasImage).toBe(true);
    expect(adminDetail.json().image.url).toBe(`/api/deals/${deal.id}/image`);
  });

  async function adminDetail(cookie: string, id: string) {
    const response = await server().inject({
      method: 'GET',
      url: `/api/admin/deals/${id}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  function editPayload(
    deal: {
      title: string;
      price: number;
      oldPrice: number | null;
      offer: string | null;
      highlights: string[];
      shortLink: string | null;
      sourceNote: string | null;
      previewEnabled: boolean;
      oldPriceVerified: boolean;
      updatedAt: string;
    },
    overrides: Record<string, unknown> = {},
  ) {
    return {
      title: deal.title,
      price: deal.price,
      oldPrice: deal.oldPrice,
      offer: deal.offer,
      highlights: deal.highlights,
      shortLink: deal.shortLink,
      sourceNote: deal.sourceNote,
      previewEnabled: deal.previewEnabled,
      oldPriceVerified: deal.oldPriceVerified,
      updatedAt: deal.updatedAt,
      ...overrides,
    };
  }

  function writeHeaders(cookie: string, contentType?: string) {
    return {
      cookie,
      origin,
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
    };
  }

  function adminImageBody(file: Buffer, filename: string, type: string, updatedAt: string) {
    const boundary = '----ssdealsadmin';
    return {
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="updatedAt"\r\n\r\n${updatedAt}\r\n` +
            `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
        ),
        file,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  it('rejects a stale save, a withdrawn deal, and an edit outside review', async () => {
    const adminCookie = await login('ada');
    const graceCookie = await login('grace');
    const { deal } = await seedDeal({
      asin: 'B0STALE001',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Stale kettle',
      pricePaise: 100000,
      oldPricePaise: 150000,
    });
    const current = await adminDetail(adminCookie, deal.id);

    const stale = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${deal.id}`,
      headers: writeHeaders(adminCookie),
      payload: editPayload(current, { updatedAt: '2020-01-01T00:00:00.000Z' }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: STALE_DEAL });

    const withdrawn = await server().inject({
      method: 'POST',
      url: `/api/deals/${deal.id}/withdraw`,
      headers: writeHeaders(graceCookie),
    });
    expect(withdrawn.statusCode).toBe(200);
    const afterWithdraw = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${deal.id}`,
      headers: writeHeaders(adminCookie),
      payload: editPayload(current, { title: 'Changed after withdraw' }),
    });
    expect(afterWithdraw.statusCode).toBe(409);
    expect(afterWithdraw.json()).toEqual({ error: STALE_DEAL });

    const { deal: draft } = await seedDeal({
      asin: 'B0DRAFT999',
      createdBy: graceId,
      status: 'draft',
      title: 'Still a draft',
      pricePaise: 50000,
    });
    const draftDetail = await adminDetail(adminCookie, draft.id);
    const locked = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${draft.id}`,
      headers: writeHeaders(adminCookie),
      payload: editPayload(draftDetail, { title: 'Nope' }),
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toEqual({ error: NOT_EDITABLE });
  });

  it('edits review fields, forces verified off without an old price, and snapshots a new price', async () => {
    const adminCookie = await login('ada');
    const clerkCookie = await login('grace');
    const { deal } = await seedDeal({
      asin: 'B0EDIT0001',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Edit me',
      pricePaise: 100000,
      oldPricePaise: 180000,
      offerText: 'Bank offer',
      highlights: ['Steel'],
      sourceNote: 'Group A',
    });
    const current = await adminDetail(adminCookie, deal.id);

    const forbidden = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${deal.id}`,
      headers: writeHeaders(clerkCookie),
      payload: editPayload(current, { title: 'Stolen' }),
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ error: FORBIDDEN_ERROR });

    const invalid = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${deal.id}`,
      headers: writeHeaders(adminCookie),
      payload: editPayload(current, {
        title: '',
        highlights: ['x'.repeat(81)],
      }),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().fields.title).toBeTruthy();
    expect(invalid.json().fields.highlights).toBeTruthy();

    const badLink = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${deal.id}`,
      headers: writeHeaders(adminCookie),
      payload: editPayload(current, { shortLink: 'http://evil.example/nope' }),
    });
    expect(badLink.statusCode).toBe(400);
    expect(badLink.json().fields.shortLink).toBeTruthy();

    const verified = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${deal.id}`,
      headers: writeHeaders(adminCookie),
      payload: editPayload(current, {
        title: 'Edited kettle',
        price: 900,
        oldPrice: 1800,
        oldPriceVerified: true,
        offer: 'Extra year',
        highlights: ['Steel', 'Quiet'],
        shortLink: 'https://amzn.to/edited1',
        sourceNote: 'Checked',
        previewEnabled: false,
      }),
    });
    expect(verified.statusCode).toBe(200);
    const saved = verified.json();
    expect(saved).toMatchObject({
      title: 'Edited kettle',
      price: 900,
      oldPrice: 1800,
      oldPriceVerified: true,
      offer: 'Extra year',
      highlights: ['Steel', 'Quiet'],
      shortLink: 'https://amzn.to/edited1',
      sourceNote: 'Checked',
      previewEnabled: false,
    });
    expect(saved.preview.html).toContain('% off');
    expect(saved.passwordHash).toBeUndefined();

    const snapshots = await database()
      .select()
      .from(priceSnapshots)
      .where(eq(priceSnapshots.dealId, deal.id));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ origin: 'owner_entered', pricePaise: 90000 });

    const cleared = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${deal.id}`,
      headers: writeHeaders(adminCookie),
      payload: editPayload(saved, { oldPrice: null, oldPriceVerified: true, price: 900 }),
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ oldPrice: null, oldPriceVerified: false, price: 900 });

    const stillOne = await database()
      .select()
      .from(priceSnapshots)
      .where(eq(priceSnapshots.dealId, deal.id));
    expect(stillOne).toHaveLength(1);

    const audits = await database()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, deal.id));
    expect(audits.map((row) => row.action)).toEqual(['deal.admin_update', 'deal.admin_update']);
  });

  it('lets an admin replace and remove an image on a deal in review', async () => {
    const adminCookie = await login('ada');
    const { deal } = await seedDeal({
      asin: 'B0IMGADMIN',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Image review',
      pricePaise: 120000,
    });
    const current = await adminDetail(adminCookie, deal.id);
    const first = adminImageBody(await png(20), 'one.png', 'image/png', current.updatedAt);
    const uploaded = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/image`,
      headers: writeHeaders(adminCookie, first.contentType),
      payload: first.payload,
    });
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().hasImage).toBe(true);

    const second = adminImageBody(await png(80), 'two.png', 'image/png', uploaded.json().updatedAt);
    const replaced = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/image`,
      headers: writeHeaders(adminCookie, second.contentType),
      payload: second.payload,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().image.mime).toBe('image/png');

    const removed = await server().inject({
      method: 'DELETE',
      url: `/api/admin/deals/${deal.id}/image`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: replaced.json().updatedAt },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().hasImage).toBe(false);

    const audits = await database()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, deal.id));
    expect(audits.map((row) => row.action)).toEqual([
      'deal.admin_image_upload',
      'deal.admin_image_upload',
      'deal.admin_image_remove',
    ]);
  });

  it('approves a waiting deal into one current caption and blocks a repost that is not lower', async () => {
    const adminCookie = await login('ada');
    const clerkCookie = await login('grace');
    const { deal } = await seedDeal({
      asin: 'B0APPRV001',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Ready kettle',
      pricePaise: 149900,
      oldPricePaise: 199900,
      highlights: ['1.5 litre'],
    });
    const current = await adminDetail(adminCookie, deal.id);

    const missing = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/approve`,
      headers: writeHeaders(clerkCookie),
      payload: { updatedAt: current.updatedAt },
    });
    expect(missing.statusCode).toBe(403);

    const stale = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/approve`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: STALE_DEAL });

    const approved = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/approve`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: current.updatedAt },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('approved');
    expect(approved.json().preview.html).toContain('Ready kettle');

    const drafts = await database()
      .select()
      .from(contentDrafts)
      .where(eq(contentDrafts.dealId, deal.id));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      isCurrent: true,
      source: 'template',
      version: 1,
      bodyHtml: approved.json().preview.html,
    });

    const again = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/approve`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: approved.json().updatedAt },
    });
    expect(again.statusCode).toBe(409);

    await seedPublished('B0REPOST1', 100000, graceId);
    const { deal: higher } = await seedDeal({
      asin: 'B0REPOST1',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Too expensive',
      pricePaise: 150000,
    });
    const higherDetail = await adminDetail(adminCookie, higher.id);
    const blocked = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${higher.id}/approve`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: higherDetail.updatedAt },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: repostRefusalMessage('price_not_lower') });
  });

  it('sends a deal back with a note the creator can read', async () => {
    const adminCookie = await login('ada');
    const graceCookie = await login('grace');
    const { deal } = await seedDeal({
      asin: 'B0BACK0001',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Needs work',
      pricePaise: 80000,
    });
    const current = await adminDetail(adminCookie, deal.id);

    const empty = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/send-back`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: current.updatedAt, note: '   ' },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: NOTE_REQUIRED });

    const sent = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/send-back`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: current.updatedAt, note: 'Please add the size.' },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({
      status: 'draft',
      reviewNote: 'Please add the size.',
    });

    const mine = await server().inject({
      method: 'GET',
      url: `/api/deals/${deal.id}`,
      headers: { cookie: graceCookie },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().deal.reviewNote).toBe('Please add the size.');
    expect(mine.json().deal.status).toBe('draft');
  });

  it('rejects, reopens, and unapproves, and reports a withdraw race', async () => {
    const adminCookie = await login('ada');
    const graceCookie = await login('grace');
    const { deal } = await seedDeal({
      asin: 'B0REJACT01',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Maybe not',
      pricePaise: 70000,
    });
    const current = await adminDetail(adminCookie, deal.id);

    const empty = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/reject`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: current.updatedAt },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: REASON_REQUIRED });

    const rejected = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/reject`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: current.updatedAt, reason: 'Wrong product.' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      status: 'rejected',
      rejectedReason: 'Wrong product.',
    });

    const reopened = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/reopen`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: rejected.json().updatedAt },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({
      status: 'pending_approval',
      rejectedReason: null,
    });

    const approved = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/approve`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: reopened.json().updatedAt },
    });
    expect(approved.statusCode).toBe(200);

    const edited = await server().inject({
      method: 'PATCH',
      url: `/api/admin/deals/${deal.id}`,
      headers: writeHeaders(adminCookie),
      payload: editPayload(approved.json(), { title: 'Caption refresh' }),
    });
    expect(edited.statusCode).toBe(200);
    const versions = await database()
      .select({
        version: contentDrafts.version,
        isCurrent: contentDrafts.isCurrent,
        bodyHtml: contentDrafts.bodyHtml,
      })
      .from(contentDrafts)
      .where(eq(contentDrafts.dealId, deal.id));
    expect(versions).toHaveLength(2);
    expect(versions.find((row) => row.isCurrent)?.bodyHtml).toContain('Caption refresh');
    expect(versions.filter((row) => row.isCurrent)).toHaveLength(1);

    const unapproved = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/unapprove`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: edited.json().updatedAt },
    });
    expect(unapproved.statusCode).toBe(200);
    expect(unapproved.json().status).toBe('pending_approval');

    const reopenedTwice = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${deal.id}/reopen`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: unapproved.json().updatedAt },
    });
    expect(reopenedTwice.statusCode).toBe(409);

    const fromApproved = await seedDeal({
      asin: 'B0REJACT02',
      createdBy: graceId,
      status: 'approved',
      title: 'Already approved',
      pricePaise: 60000,
    });
    const approvedDetail = await adminDetail(adminCookie, fromApproved.deal.id);
    const rejectApproved = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${fromApproved.deal.id}/reject`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: approvedDetail.updatedAt, reason: 'Changed our mind.' },
    });
    expect(rejectApproved.statusCode).toBe(200);
    expect(rejectApproved.json().status).toBe('rejected');

    const { deal: racing } = await seedDeal({
      asin: 'B0RACE0001',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Race',
      pricePaise: 50000,
    });
    const raced = await adminDetail(adminCookie, racing.id);
    const withdraw = await server().inject({
      method: 'POST',
      url: `/api/deals/${racing.id}/withdraw`,
      headers: writeHeaders(graceCookie),
    });
    expect(withdraw.statusCode).toBe(200);
    const lost = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${racing.id}/approve`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: raced.updatedAt },
    });
    expect(lost.statusCode).toBe(409);
    expect(lost.json()).toEqual({ error: WITHDRAWN_DEAL });

    const audits = await database()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.entityId, deal.id));
    expect(audits.map((row) => row.action)).toEqual([
      'deal.reject',
      'deal.reopen',
      'deal.approve',
      'deal.admin_update',
      'deal.unapprove',
    ]);
  });

  it('counts a sent-back deal and ignores drafts that were never reviewed', async () => {
    const adminCookie = await login('ada');
    const graceCookie = await login('grace');

    await seedDeal({
      asin: 'B0NEVER001',
      createdBy: graceId,
      status: 'draft',
      title: 'Never sent',
      pricePaise: 10000,
    });

    const { deal: waiting } = await seedDeal({
      asin: 'B0WITHDR01',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Pulled back',
      pricePaise: 11000,
    });
    const withdrawn = await server().inject({
      method: 'POST',
      url: `/api/deals/${waiting.id}/withdraw`,
      headers: writeHeaders(graceCookie),
    });
    expect(withdrawn.statusCode).toBe(200);

    const { deal: queued } = await seedDeal({
      asin: 'B0SENTB001',
      createdBy: graceId,
      status: 'pending_approval',
      title: 'Needs a size',
      pricePaise: 12000,
    });
    const current = await adminDetail(adminCookie, queued.id);
    const sent = await server().inject({
      method: 'POST',
      url: `/api/admin/deals/${queued.id}/send-back`,
      headers: writeHeaders(adminCookie),
      payload: { updatedAt: current.updatedAt, note: 'Please add the size.' },
    });
    expect(sent.statusCode).toBe(200);

    const listed = await server().inject({
      method: 'GET',
      url: '/api/admin/deals?status=sent_back',
      headers: { cookie: adminCookie },
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(body.counts.sent_back).toBe(1);
    expect(body.counts.draft).toBe(3);
    expect(body.items.map((item: { title: string }) => item.title)).toEqual(['Needs a size']);

    const edited = await server().inject({
      method: 'PATCH',
      url: `/api/deals/${queued.id}`,
      headers: writeHeaders(graceCookie),
      payload: {
        productUrl: 'https://www.amazon.in/dp/B0SENTB001',
        title: 'Needs a size, 1 L',
        price: '1200',
        highlights: [],
      },
    });
    expect(edited.statusCode).toBe(200);

    const again = await server().inject({
      method: 'POST',
      url: `/api/deals/${queued.id}/submit`,
      headers: writeHeaders(graceCookie),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().deal.status).toBe('pending_approval');

    const after = await server().inject({
      method: 'GET',
      url: '/api/admin/deals?status=sent_back',
      headers: { cookie: adminCookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().counts.sent_back).toBe(0);
    expect(after.json().items).toEqual([]);
  });
});
