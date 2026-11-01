import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '../../src/db/schema/index.js';
import {
  affiliateLinks,
  channels,
  contentDrafts,
  deals,
  priceSnapshots,
  products,
  publications,
  users,
} from '../../src/db/schema/index.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? '';
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

if (databaseUrl === '') {
  console.info(
    'Schema integration tests skipped: set TEST_DATABASE_URL to a database whose name ends with _test.',
  );
} else {
  assertTestDatabaseName(databaseUrl);
}

type Database = NodePgDatabase<typeof schema>;

let pool: Pool | undefined;
let db: Database | undefined;

function assertTestDatabaseName(connectionString: string): string {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error(
      'Refusing to run schema integration tests: TEST_DATABASE_URL is not a valid database URL.',
    );
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName.endsWith('_test')) {
    throw new Error(
      `Refusing to run schema integration tests: database name "${databaseName || '(empty)'}" must end with "_test".`,
    );
  }

  return databaseName;
}

function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (
    current !== null &&
    current !== undefined &&
    typeof current === 'object' &&
    !seen.has(current)
  ) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }

  return undefined;
}

async function expectPostgresCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(postgresErrorCode(error)).toBe(code);
    return;
  }

  throw new Error(`expected Postgres error ${code}, but the statement succeeded`);
}

function database(): Database {
  if (db === undefined) {
    throw new Error('schema integration database is not connected');
  }
  return db;
}

function token(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function insertUser(role: 'owner' | 'clerk' = 'clerk', telegramUserId?: bigint | null) {
  const [user] = await database()
    .insert(users)
    .values({
      username: token(role),
      role,
      ...(telegramUserId === undefined ? {} : { telegramUserId }),
    })
    .returning();

  if (user === undefined) {
    throw new Error('user insert did not return a row');
  }
  return user;
}

async function insertProduct(source: 'amazon' | 'flipkart' = 'amazon', externalId = token('asin')) {
  const [product] = await database()
    .insert(products)
    .values({
      source,
      externalId,
      canonicalUrl: `https://example.test/products/${externalId}`,
    })
    .returning();

  if (product === undefined) {
    throw new Error('product insert did not return a row');
  }
  return product;
}

async function insertLink(productId: string, createdBy: string) {
  const [link] = await database()
    .insert(affiliateLinks)
    .values({
      productId,
      platform: 'amazon',
      originalUrl: 'https://example.test/product',
      affiliateUrl: 'https://example.test/product?tag=demo-21',
      verification: 'tag_appended',
      validationStatus: 'unvalidated',
      createdBy,
    })
    .returning();

  if (link === undefined) {
    throw new Error('affiliate link insert did not return a row');
  }
  return link;
}

async function insertDeal(input: {
  productId: string;
  linkId: string;
  createdBy: string;
  status?:
    'draft' | 'pending_approval' | 'approved' | 'scheduled' | 'published' | 'rejected' | 'failed';
  pricePaise?: number;
  oldPricePaise?: number | null;
  oldPriceVerified?: boolean;
  offerText?: string | null;
}) {
  const [deal] = await database()
    .insert(deals)
    .values({
      productId: input.productId,
      linkId: input.linkId,
      createdBy: input.createdBy,
      status: input.status ?? 'draft',
      pricePaise: input.pricePaise ?? 10_000,
      ...(input.oldPricePaise === undefined ? {} : { oldPricePaise: input.oldPricePaise }),
      ...(input.oldPriceVerified === undefined ? {} : { oldPriceVerified: input.oldPriceVerified }),
      ...(input.offerText === undefined ? {} : { offerText: input.offerText }),
    })
    .returning();

  if (deal === undefined) {
    throw new Error('deal insert did not return a row');
  }
  return deal;
}

async function insertCurrentDraft(dealId: string, version = 1, isCurrent = true) {
  const [draft] = await database()
    .insert(contentDrafts)
    .values({
      dealId,
      version,
      bodyHtml: `<p>version ${version}</p>`,
      source: 'manual_edit',
      isCurrent,
    })
    .returning();

  if (draft === undefined) {
    throw new Error('content draft insert did not return a row');
  }
  return draft;
}

async function insertChannel() {
  const [channel] = await database()
    .insert(channels)
    .values({
      platform: 'telegram',
      name: 'Deals',
      username: token('channel'),
      isActive: true,
    })
    .returning();

  if (channel === undefined) {
    throw new Error('channel insert did not return a row');
  }
  return channel;
}

describe.skipIf(databaseUrl === '')('phase 1 schema constraints', () => {
  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 2_000,
      max: 5,
    });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder });
    await migrate(db, { migrationsFolder });
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await pool?.query(`
      TRUNCATE TABLE
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
  });

  it('rejects a duplicate product source and external id', async () => {
    const externalId = 'B00DUPLICATE';
    await insertProduct('amazon', externalId);
    await expectPostgresCode(() => insertProduct('amazon', externalId), '23505');
    await insertProduct('flipkart', externalId);
  });

  it('allows only one active deal per product', async () => {
    const user = await insertUser();
    const product = await insertProduct();
    const link = await insertLink(product.id, user.id);
    const first = await insertDeal({
      productId: product.id,
      linkId: link.id,
      createdBy: user.id,
      status: 'draft',
    });

    await expectPostgresCode(
      () =>
        insertDeal({
          productId: product.id,
          linkId: link.id,
          createdBy: user.id,
          status: 'pending_approval',
        }),
      '23505',
    );

    for (const blockingStatus of ['approved', 'scheduled'] as const) {
      await database().update(deals).set({ status: blockingStatus }).where(eq(deals.id, first.id));
      await expectPostgresCode(
        () =>
          insertDeal({
            productId: product.id,
            linkId: link.id,
            createdBy: user.id,
            status: 'draft',
          }),
        '23505',
      );
    }

    for (const openStatus of ['published', 'rejected', 'failed'] as const) {
      await database().update(deals).set({ status: openStatus }).where(eq(deals.id, first.id));
      const next = await insertDeal({
        productId: product.id,
        linkId: link.id,
        createdBy: user.id,
        status: 'draft',
      });
      await database().delete(deals).where(eq(deals.id, next.id));
    }
  });

  it('rejects two publications for the same channel and deal', async () => {
    const user = await insertUser();
    const product = await insertProduct();
    const link = await insertLink(product.id, user.id);
    const deal = await insertDeal({
      productId: product.id,
      linkId: link.id,
      createdBy: user.id,
      status: 'published',
    });
    const draft = await insertCurrentDraft(deal.id);
    const channel = await insertChannel();

    await database().insert(publications).values({
      dealId: deal.id,
      productId: product.id,
      channelId: channel.id,
      contentDraftId: draft.id,
      status: 'published',
      postedPricePaise: 10_000,
    });

    await expectPostgresCode(
      () =>
        database().insert(publications).values({
          dealId: deal.id,
          productId: product.id,
          channelId: channel.id,
          contentDraftId: draft.id,
          status: 'failed',
        }),
      '23505',
    );
  });

  it('allows one in-flight publication per channel and product, and lets failed or published rows through', async () => {
    const user = await insertUser();
    const product = await insertProduct();
    const link = await insertLink(product.id, user.id);
    const channel = await insertChannel();

    async function publishedDeal() {
      const deal = await insertDeal({
        productId: product.id,
        linkId: link.id,
        createdBy: user.id,
        status: 'published',
      });
      const draft = await insertCurrentDraft(deal.id);
      return { deal, draft };
    }

    const first = await publishedDeal();
    const second = await publishedDeal();
    const [inflight] = await database()
      .insert(publications)
      .values({
        dealId: first.deal.id,
        productId: product.id,
        channelId: channel.id,
        contentDraftId: first.draft.id,
        status: 'queued',
      })
      .returning();

    if (inflight === undefined) {
      throw new Error('publication insert did not return a row');
    }

    for (const status of ['queued', 'publishing', 'uncertain'] as const) {
      await database().update(publications).set({ status }).where(eq(publications.id, inflight.id));
      await expectPostgresCode(
        () =>
          database().insert(publications).values({
            dealId: second.deal.id,
            productId: product.id,
            channelId: channel.id,
            contentDraftId: second.draft.id,
            status: 'queued',
          }),
        '23505',
      );
    }

    await database()
      .update(publications)
      .set({ status: 'failed' })
      .where(eq(publications.id, inflight.id));
    const [retry] = await database()
      .insert(publications)
      .values({
        dealId: second.deal.id,
        productId: product.id,
        channelId: channel.id,
        contentDraftId: second.draft.id,
        status: 'queued',
      })
      .returning();

    if (retry === undefined) {
      throw new Error('retry publication insert did not return a row');
    }

    await database()
      .update(publications)
      .set({ status: 'published' })
      .where(eq(publications.id, retry.id));

    const third = await publishedDeal();
    await database().insert(publications).values({
      dealId: third.deal.id,
      productId: product.id,
      channelId: channel.id,
      contentDraftId: third.draft.id,
      status: 'published',
      postedPricePaise: 9_000,
    });
  });

  it('allows only one current content draft per deal', async () => {
    const user = await insertUser();
    const product = await insertProduct();
    const link = await insertLink(product.id, user.id);
    const deal = await insertDeal({
      productId: product.id,
      linkId: link.id,
      createdBy: user.id,
    });
    const current = await insertCurrentDraft(deal.id, 1, true);

    await expectPostgresCode(() => insertCurrentDraft(deal.id, 2, true), '23505');
    const next = await insertCurrentDraft(deal.id, 2, false);

    await database()
      .update(contentDrafts)
      .set({ isCurrent: false })
      .where(eq(contentDrafts.id, current.id));
    await database()
      .update(contentDrafts)
      .set({ isCurrent: true })
      .where(eq(contentDrafts.id, next.id));
  });

  it('rejects a non-positive price in paise', async () => {
    const user = await insertUser();
    const product = await insertProduct();
    const link = await insertLink(product.id, user.id);

    for (const pricePaise of [0, -1]) {
      await expectPostgresCode(
        () =>
          insertDeal({
            productId: product.id,
            linkId: link.id,
            createdBy: user.id,
            pricePaise,
          }),
        '23514',
      );
      await expectPostgresCode(
        () =>
          database().insert(priceSnapshots).values({
            productId: product.id,
            pricePaise,
            origin: 'clerk_entered',
            recordedBy: user.id,
          }),
        '23514',
      );
    }

    await insertDeal({
      productId: product.id,
      linkId: link.id,
      createdBy: user.id,
      pricePaise: 1,
    });
  });

  it('rejects an old price that is not above the deal price, and a verified flag without an old price', async () => {
    const user = await insertUser();
    const product = await insertProduct();
    const link = await insertLink(product.id, user.id);
    const base = {
      productId: product.id,
      linkId: link.id,
      createdBy: user.id,
      pricePaise: 10_000,
    };

    await expectPostgresCode(() => insertDeal({ ...base, oldPricePaise: 10_000 }), '23514');
    await expectPostgresCode(() => insertDeal({ ...base, oldPricePaise: 9_999 }), '23514');
    await expectPostgresCode(
      () => insertDeal({ ...base, oldPricePaise: null, oldPriceVerified: true }),
      '23514',
    );

    await insertDeal({ ...base, oldPricePaise: 10_001, oldPriceVerified: true });
    const productTwo = await insertProduct();
    const linkTwo = await insertLink(productTwo.id, user.id);
    await insertDeal({
      productId: productTwo.id,
      linkId: linkTwo.id,
      createdBy: user.id,
      pricePaise: 10_000,
      oldPricePaise: null,
      oldPriceVerified: false,
    });
  });

  it('rejects offer text longer than 120 characters', async () => {
    const user = await insertUser();
    const product = await insertProduct();
    const link = await insertLink(product.id, user.id);
    const base = {
      productId: product.id,
      linkId: link.id,
      createdBy: user.id,
    };

    await insertDeal({ ...base, offerText: 'a'.repeat(120) });
    await database().delete(deals);
    await expectPostgresCode(() => insertDeal({ ...base, offerText: 'a'.repeat(121) }), '23514');
    await insertDeal({ ...base, offerText: null });
  });

  it('rejects orphan foreign keys', async () => {
    const user = await insertUser();
    const product = await insertProduct();
    const link = await insertLink(product.id, user.id);
    const missing = randomUUID();

    await expectPostgresCode(
      () =>
        insertDeal({
          productId: missing,
          linkId: link.id,
          createdBy: user.id,
        }),
      '23503',
    );
    await expectPostgresCode(
      () =>
        insertDeal({
          productId: product.id,
          linkId: missing,
          createdBy: user.id,
        }),
      '23503',
    );
    await expectPostgresCode(
      () =>
        insertDeal({
          productId: product.id,
          linkId: link.id,
          createdBy: missing,
        }),
      '23503',
    );
    await expectPostgresCode(() => insertLink(missing, user.id), '23503');
    await expectPostgresCode(
      () =>
        database().insert(priceSnapshots).values({
          productId: missing,
          pricePaise: 100,
          origin: 'api',
        }),
      '23503',
    );
    await expectPostgresCode(
      () =>
        database().insert(contentDrafts).values({
          dealId: missing,
          version: 1,
          bodyHtml: '<p>orphan</p>',
          source: 'template',
          isCurrent: true,
        }),
      '23503',
    );

    const deal = await insertDeal({
      productId: product.id,
      linkId: link.id,
      createdBy: user.id,
      status: 'published',
    });
    const draft = await insertCurrentDraft(deal.id);
    const channel = await insertChannel();
    await expectPostgresCode(
      () =>
        database().insert(publications).values({
          dealId: missing,
          productId: product.id,
          channelId: channel.id,
          contentDraftId: draft.id,
          status: 'queued',
        }),
      '23503',
    );
  });

  it('keeps telegram user ids unique when set and allows several nulls', async () => {
    const telegramUserId = 42n;
    await insertUser('owner', null);
    await insertUser('clerk', null);
    await insertUser('clerk', telegramUserId);
    await expectPostgresCode(() => insertUser('owner', telegramUserId), '23505');
    await insertUser('clerk', 43n);
  });
});
