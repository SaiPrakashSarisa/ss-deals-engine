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
  channels,
  contentDrafts,
  deals,
  products,
  publications,
  users,
} from '../../src/db/schema/index.js';
import { FORBIDDEN_ERROR, SIGN_IN_REQUIRED } from '../../src/modules/auth/messages.js';
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
});
