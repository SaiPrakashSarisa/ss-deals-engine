import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema/index.js';
import {
  affiliateLinks,
  contentDrafts,
  deals,
  products,
  publications,
  users,
} from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { DealHttpError } from '../../src/modules/deals/errors.js';
import { createDraft } from '../../src/modules/deals/service.js';
import { parseDealBody } from '../../src/modules/deals/validation.js';
import { publishDeal } from '../../src/modules/publishing/service.js';
import type { TelegramClient } from '../../src/modules/publishing/telegram.js';
import { UNKNOWN_PRICE } from '../../src/modules/publishing/messages.js';
import { listAdminDeals } from '../../src/modules/review/service.js';
import { importPostedHistory, parsePostedLog } from '../../src/scripts/import-quickpost.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

if (databaseUrl === '') {
  console.info(
    'Quick-post import tests skipped: set TEST_DATABASE_URL to a database whose name ends with _test.',
  );
} else {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to run import tests against database "${name}".`);
  }
}

type Database = NodePgDatabase<typeof schema>;

const sample = JSON.stringify({
  entries: [
    {
      asin: 'B0IMPORT01',
      timestamp: '2026-11-01T04:00:00.000Z',
      message_id: 42,
      mode: 'photo',
      link: 'short',
      title: 'Logged kettle',
      channel: '@history_channel',
    },
    {
      asin: 'B0IMPORT02',
      timestamp: '2026-11-02T04:00:00.000Z',
      message_id: 'uncertain',
    },
    {
      asin: 'B0IMPORT01',
      timestamp: '2026-11-03T04:00:00.000Z',
      message_id: 43,
    },
    { asin: 'not-an-asin', timestamp: 'yesterday', message_id: 1 },
  ],
});

let pool: Pool | undefined;
let db: Database | undefined;
let adminId = '';

function database(): Database {
  if (db === undefined) {
    throw new Error('database is not ready');
  }
  return db;
}

async function importSample(dryRun = false) {
  const parsed = parsePostedLog(sample);
  const counts = await importPostedHistory(database(), {
    entries: parsed.entries,
    adminUserId: adminId,
    amazonTag: 'example-21',
    defaultChannel: '@deals_channel',
    dryRun,
  });
  return { parsed, counts };
}

describe.skipIf(databaseUrl === '')('quick-post history import', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
  });

  beforeEach(async () => {
    await pool?.query(`
      TRUNCATE TABLE
        sessions, publications, content_drafts, price_snapshots, deals,
        affiliate_links, channels, products, users, settings, audit_log
      RESTART IDENTITY CASCADE
    `);
    const [admin] = await database()
      .insert(users)
      .values({
        username: 'ada',
        role: 'owner',
        isActive: true,
        displayName: 'Ada Lovelace',
        passwordHash: await hashPassword('correct-horse-battery'),
      })
      .returning({ id: users.id });
    if (admin === undefined) {
      throw new Error('admin seed failed');
    }
    adminId = admin.id;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('imports a sample log once, skips a repeat, and ignores a dry run', async () => {
    const first = await importSample();
    expect(first.parsed.errors).toEqual(['Entry 4: not a valid post log entry.']);
    expect(first.counts).toMatchObject({ imported: 2, skipped: 1, failed: 0 });

    const rows = await database()
      .select({
        title: deals.title,
        pricePaise: deals.pricePaise,
        sourceNote: deals.sourceNote,
        status: deals.status,
        asin: products.externalId,
        affiliateUrl: affiliateLinks.affiliateUrl,
        verification: affiliateLinks.verification,
        validationStatus: affiliateLinks.validationStatus,
        body: contentDrafts.bodyHtml,
        origin: publications.origin,
        messageId: publications.externalMessageId,
        postedPrice: publications.postedPricePaise,
        mode: publications.mode,
        linkKind: publications.linkKind,
      })
      .from(deals)
      .innerJoin(products, eq(products.id, deals.productId))
      .innerJoin(affiliateLinks, eq(affiliateLinks.id, deals.linkId))
      .innerJoin(contentDrafts, eq(contentDrafts.dealId, deals.id))
      .innerJoin(publications, eq(publications.dealId, deals.id));
    expect(rows).toHaveLength(2);
    const titled = rows.find((row) => row.asin === 'B0IMPORT01');
    expect(titled).toMatchObject({
      title: 'Logged kettle',
      pricePaise: 100,
      sourceNote: 'quickpost_import',
      status: 'published',
      verification: 'tag_appended',
      validationStatus: 'structure_ok',
      body: 'Imported from quick-post',
      origin: 'quickpost_import',
      messageId: '42',
      postedPrice: null,
      mode: 'photo',
      linkKind: 'short',
    });
    expect(titled?.affiliateUrl).toContain('tag=example-21');
    expect(rows.find((row) => row.asin === 'B0IMPORT02')).toMatchObject({
      title: 'Imported: B0IMPORT02',
      messageId: 'uncertain',
      mode: 'text',
      linkKind: 'tagged',
    });

    const queue = await listAdminDeals(database(), { status: 'published' });
    expect(queue.counts.published).toBe(0);
    expect(queue.items).toHaveLength(0);
    const [posted] = await database()
      .select({ count: sql<number>`count(*)::int` })
      .from(publications)
      .where(and(eq(publications.origin, 'app'), eq(publications.status, 'published')));
    expect(posted?.count).toBe(0);

    const second = await importSample();
    expect(second.counts).toMatchObject({ imported: 0, skipped: 3, failed: 0 });
    const [dealCount] = await database()
      .select({ count: sql<number>`count(*)::int` })
      .from(deals);
    expect(dealCount?.count).toBe(2);

    const dry = await importPostedHistory(database(), {
      entries: [
        {
          asin: 'B0IMPORT03',
          timestamp: '2026-11-04T04:00:00.000Z',
          message_id: 9,
        },
      ],
      adminUserId: adminId,
      amazonTag: 'example-21',
      defaultChannel: '@deals_channel',
      dryRun: true,
    });
    expect(dry).toMatchObject({ imported: 1, skipped: 0, failed: 0 });
    const [afterDry] = await database()
      .select({ count: sql<number>`count(*)::int` })
      .from(deals);
    expect(afterDry?.count).toBe(2);
  });

  it('blocks a new deal for an imported ASIN until the unknown price is confirmed', async () => {
    await importSample();
    const parsed = parseDealBody(
      {
        title: 'Again',
        price: '50',
        productUrl: 'https://www.amazon.in/dp/B0IMPORT01',
        highlights: [],
      },
      { amazonTag: 'example-21', shortLinkHosts: ['amzn.to'] },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    await expect(
      createDraft(
        database(),
        { id: adminId, username: 'ada', role: 'owner', displayName: 'Ada Lovelace' },
        parsed.value,
        'example-21',
      ),
    ).rejects.toThrow(/earlier price is missing/);

    const [product] = await database()
      .select({ id: products.id })
      .from(products)
      .where(eq(products.externalId, 'B0IMPORT01'))
      .limit(1);
    if (product === undefined) {
      throw new Error('imported product missing');
    }
    const [link] = await database()
      .insert(affiliateLinks)
      .values({
        productId: product.id,
        platform: 'amazon',
        originalUrl: 'https://www.amazon.in/dp/B0IMPORT01',
        affiliateUrl: 'https://www.amazon.in/dp/B0IMPORT01?tag=example-21',
        affiliateTag: 'example-21',
        verification: 'tag_appended',
        validationStatus: 'structure_ok',
        createdBy: adminId,
      })
      .returning({ id: affiliateLinks.id });
    const [deal] = await database()
      .insert(deals)
      .values({
        productId: product.id,
        linkId: link?.id ?? '',
        status: 'approved',
        title: 'Again',
        pricePaise: 5000,
        highlights: [],
        createdBy: adminId,
      })
      .returning({ id: deals.id, updatedAt: deals.updatedAt });
    if (deal === undefined) {
      throw new Error('approved seed failed');
    }
    await database().insert(contentDrafts).values({
      dealId: deal.id,
      version: 1,
      bodyHtml: '<b>Again</b>',
      source: 'manual_edit',
      isCurrent: true,
    });
    const client: TelegramClient = {
      async sendText() {
        return { kind: 'ok', messageId: 7 };
      },
      async sendPhoto() {
        return { kind: 'ok', messageId: 7 };
      },
    };
    const config = {
      enabled: true,
      channel: '@deals_channel',
      token: '123456:SECRETTOKEN',
      dailyLimit: 8,
      minGapMinutes: 0,
      maxLateMinutes: 120,
      linkStyle: 'text' as const,
      postFooter: '',
      uploadDir: '/tmp',
      shortLinkHosts: ['amzn.to'],
    };
    const actor = { id: adminId, now: new Date() };
    await expect(
      publishDeal(
        database(),
        actor,
        deal.id,
        { updatedAt: deal.updatedAt, override: false, confirmUnknownPrice: false },
        { client, config },
      ),
    ).rejects.toBeInstanceOf(DealHttpError);
    await expect(
      publishDeal(
        database(),
        actor,
        deal.id,
        { updatedAt: deal.updatedAt, override: false, confirmUnknownPrice: false },
        { client, config },
      ),
    ).rejects.toThrow(UNKNOWN_PRICE);
    const published = await publishDeal(
      database(),
      actor,
      deal.id,
      { updatedAt: deal.updatedAt, override: true, confirmUnknownPrice: true },
      { client, config },
    );
    expect(published.deal.status).toBe('published');
    expect(published.publication.externalMessageId).toBe('7');
  });
});
