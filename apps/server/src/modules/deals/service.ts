import { and, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { parseAmazonProductUrl } from '@ss-deals/core';
import {
  affiliateLinks,
  auditLog,
  deals,
  priceSnapshots,
  products,
  publications,
} from '../../db/schema/index.js';
import type { Database } from '../../lib/db.js';
import type { AuthUser } from '../auth/service.js';
import { classifyUrlCheck, type UrlCheck } from './check.js';
import { DealHttpError } from './errors.js';
import {
  ACTIVE_DEAL_MESSAGE,
  ALREADY_REVIEWED,
  IMAGE_NONE_ERROR,
  NOT_EDITABLE,
  NOT_FOUND,
  ONLY_DRAFT,
  OWN_DRAFT_ONLY,
  TITLE_ERROR,
  repostRefusalMessage,
} from './messages.js';
import { evaluateRepost } from './repost.js';
import { assertTransition } from './status.js';
import type { DealStatus } from './status.js';
import type { DealInput } from './validation.js';
import { readStoredImage } from '../uploads/files.js';

type DealDb = Database['db'];

const ACTIVE_DEAL_STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled'] as const;

const dealColumns = {
  id: deals.id,
  status: deals.status,
  title: deals.title,
  productUrl: affiliateLinks.originalUrl,
  taggedUrl: affiliateLinks.affiliateUrl,
  shortLink: affiliateLinks.shortUrl,
  pricePaise: deals.pricePaise,
  oldPricePaise: deals.oldPricePaise,
  oldPriceVerified: deals.oldPriceVerified,
  highlights: deals.highlights,
  offer: deals.offerText,
  sourceNote: deals.sourceNote,
  clerkNotes: deals.clerkNotes,
  reviewNote: deals.reviewNote,
  rejectedReason: deals.rejectedReason,
  imagePath: deals.imagePath,
  imageMime: deals.imageMime,
  productId: deals.productId,
  linkId: deals.linkId,
  externalId: products.externalId,
  createdBy: deals.createdBy,
  submittedAt: deals.submittedAt,
  createdAt: deals.createdAt,
  updatedAt: deals.updatedAt,
};

type DealRow = {
  id: string;
  status: DealStatus;
  title: string;
  productUrl: string;
  taggedUrl: string;
  shortLink: string | null;
  pricePaise: number;
  oldPricePaise: number | null;
  oldPriceVerified: boolean;
  highlights: unknown;
  offer: string | null;
  sourceNote: string | null;
  clerkNotes: string | null;
  reviewNote: string | null;
  rejectedReason: string | null;
  imagePath: string | null;
  imageMime: string | null;
  productId: string;
  linkId: string;
  externalId: string;
  createdBy: string;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DealJson = {
  id: string;
  status: DealStatus;
  title: string;
  productUrl: string;
  taggedUrl: string;
  shortLink: string | null;
  pricePaise: number;
  oldPricePaise: number | null;
  oldPriceVerified: boolean;
  highlights: string[];
  offer: string | null;
  sourceNote: string | null;
  clerkNotes: string | null;
  reviewNote: string | null;
  rejectedReason: string | null;
  hasImage: boolean;
  editable: boolean;
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function canRead(user: AuthUser, createdBy: string): boolean {
  return user.role === 'owner' || user.id === createdBy;
}

function isActiveDealStatus(status: DealStatus): boolean {
  return (ACTIVE_DEAL_STATUSES as readonly DealStatus[]).includes(status);
}

function highlightsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function toJson(row: DealRow, user: AuthUser): DealJson {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    productUrl: row.productUrl,
    taggedUrl: row.taggedUrl,
    shortLink: row.shortLink,
    pricePaise: row.pricePaise,
    oldPricePaise: row.oldPricePaise,
    oldPriceVerified: row.oldPriceVerified,
    highlights: highlightsOf(row.highlights),
    offer: row.offer,
    sourceNote: row.sourceNote,
    clerkNotes: row.clerkNotes,
    reviewNote: row.reviewNote,
    rejectedReason: row.rejectedReason,
    hasImage: row.imagePath !== null && row.imageMime !== null,
    editable: row.createdBy === user.id && row.status === 'draft',
    submittedAt: row.submittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function transaction<T>(db: DealDb, run: (tx: DealDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => run(tx as unknown as DealDb));
}

async function loadDeal(db: DealDb, id: string): Promise<DealRow | undefined> {
  const [row] = await db
    .select(dealColumns)
    .from(deals)
    .innerJoin(products, eq(products.id, deals.productId))
    .innerJoin(affiliateLinks, eq(affiliateLinks.id, deals.linkId))
    .where(eq(deals.id, id))
    .limit(1);
  return row;
}

async function findProduct(db: DealDb, asin: string): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.source, 'amazon'), eq(products.externalId, asin)))
    .limit(1);
  return row;
}

async function hasActiveDeal(
  db: DealDb,
  productId: string,
  exceptDealId?: string,
): Promise<boolean> {
  const filters = [
    eq(deals.productId, productId),
    inArray(deals.status, [...ACTIVE_DEAL_STATUSES]),
  ];
  if (exceptDealId !== undefined) {
    filters.push(ne(deals.id, exceptDealId));
  }
  const [row] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(and(...filters))
    .limit(1);
  return row !== undefined;
}

async function latestPublishedPrice(
  db: DealDb,
  productId: string,
): Promise<{ postedPricePaise: number | null } | null> {
  const [row] = await db
    .select({ postedPricePaise: publications.postedPricePaise })
    .from(publications)
    .where(and(eq(publications.productId, productId), eq(publications.status, 'published')))
    .orderBy(sql`${publications.publishedAt} desc nulls last`, desc(publications.createdAt))
    .limit(1);
  return row ?? null;
}

const earlierCodes = new Set([
  'in_queue',
  'posted_blocked',
  'posted_unknown_price',
  'posted_lower',
  'awaiting_price',
]);

type EarlierSource = {
  id: string;
  title: string;
  highlights: unknown;
  shortLink: string | null;
  sourceNote: string | null;
  previewEnabled: boolean;
  imagePath: string | null;
  createdBy: string;
  status: DealStatus;
  postedAt: Date | null;
  postedPricePaise: number | null;
};

async function findEarlierDeal(
  db: DealDb,
  user: AuthUser,
  productId: string,
  exceptDealId?: string,
): Promise<EarlierSource | null> {
  const publishedFilters = [eq(deals.productId, productId)];
  if (exceptDealId !== undefined) {
    publishedFilters.push(ne(deals.id, exceptDealId));
  }
  const [published] = await db
    .select({
      id: deals.id,
      title: deals.title,
      highlights: deals.highlights,
      shortLink: affiliateLinks.shortUrl,
      sourceNote: deals.sourceNote,
      previewEnabled: deals.previewEnabled,
      imagePath: deals.imagePath,
      createdBy: deals.createdBy,
      status: deals.status,
      postedAt: publications.publishedAt,
      postedPricePaise: publications.postedPricePaise,
    })
    .from(deals)
    .innerJoin(affiliateLinks, eq(affiliateLinks.id, deals.linkId))
    .innerJoin(
      publications,
      and(eq(publications.dealId, deals.id), eq(publications.status, 'published')),
    )
    .where(and(...publishedFilters))
    .orderBy(desc(publications.publishedAt), desc(deals.createdAt))
    .limit(1);
  if (published !== undefined) {
    return published;
  }
  const ownFilters = [eq(deals.productId, productId), eq(deals.createdBy, user.id)];
  if (exceptDealId !== undefined) {
    ownFilters.push(ne(deals.id, exceptDealId));
  }
  const [own] = await db
    .select({
      id: deals.id,
      title: deals.title,
      highlights: deals.highlights,
      shortLink: affiliateLinks.shortUrl,
      sourceNote: deals.sourceNote,
      previewEnabled: deals.previewEnabled,
      imagePath: deals.imagePath,
      createdBy: deals.createdBy,
      status: deals.status,
    })
    .from(deals)
    .innerJoin(affiliateLinks, eq(affiliateLinks.id, deals.linkId))
    .where(and(...ownFilters))
    .orderBy(desc(deals.updatedAt), desc(deals.createdAt))
    .limit(1);
  if (own === undefined) {
    return null;
  }
  return { ...own, postedAt: null, postedPricePaise: null };
}

async function earlierSummary(
  db: DealDb,
  user: AuthUser,
  productId: string | undefined,
  exceptDealId: string | undefined,
  code: string,
): Promise<UrlCheck['earlier']> {
  if (productId === undefined || !earlierCodes.has(code)) {
    return null;
  }
  const found = await findEarlierDeal(db, user, productId, exceptDealId);
  if (found === null) {
    return null;
  }
  return {
    id: found.id,
    postedAt: found.postedAt?.toISOString() ?? null,
    postedPricePaise: found.postedPricePaise,
  };
}

async function assertCreatable(
  db: DealDb,
  user: AuthUser,
  productId: string,
  pricePaise: number,
  confirmUnknownPrice: boolean,
  exceptDealId?: string,
): Promise<boolean> {
  if (await hasActiveDeal(db, productId, exceptDealId)) {
    throw new DealHttpError(409, ACTIVE_DEAL_MESSAGE);
  }
  const decision = evaluateRepost({
    previous: await latestPublishedPrice(db, productId),
    newPricePaise: pricePaise,
  });
  if (decision.reason === 'previous_price_unknown') {
    if (user.role === 'owner' && confirmUnknownPrice) {
      return true;
    }
    throw new DealHttpError(409, repostRefusalMessage('previous_price_unknown'));
  }
  if (!decision.allowed && decision.reason !== 'first_post') {
    throw new DealHttpError(409, repostRefusalMessage('price_not_lower'));
  }
  return false;
}

async function upsertProduct(
  db: DealDb,
  input: { asin: string; taggedUrl: string; title: string },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(products)
    .values({
      source: 'amazon',
      externalId: input.asin,
      canonicalUrl: input.taggedUrl,
      title: input.title,
    })
    .onConflictDoUpdate({
      target: [products.source, products.externalId],
      set: { canonicalUrl: input.taggedUrl, title: input.title },
    })
    .returning({ id: products.id });
  if (row === undefined) {
    throw new Error('product upsert did not return a row');
  }
  return row;
}

async function prepareProduct(
  db: DealDb,
  user: AuthUser,
  input: DealInput,
  exceptDealId?: string,
): Promise<{ id: string; confirmedUnknownPrice: boolean }> {
  const existing = await findProduct(db, input.asin);
  let confirmedUnknownPrice = false;
  if (existing !== undefined) {
    confirmedUnknownPrice = await assertCreatable(
      db,
      user,
      existing.id,
      input.pricePaise,
      input.confirmUnknownPrice,
      exceptDealId,
    );
  }
  const product = await upsertProduct(db, input);
  if (existing === undefined) {
    confirmedUnknownPrice = await assertCreatable(
      db,
      user,
      product.id,
      input.pricePaise,
      input.confirmUnknownPrice,
    );
  }
  return { id: product.id, confirmedUnknownPrice };
}

async function insertLink(
  db: DealDb,
  input: DealInput,
  productId: string,
  userId: string,
  amazonTag: string,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(affiliateLinks)
    .values({
      productId,
      platform: 'amazon',
      originalUrl: input.originalUrl,
      affiliateUrl: input.taggedUrl,
      shortUrl: input.shortLink,
      affiliateTag: amazonTag,
      verification: 'tag_appended',
      validationStatus: 'structure_ok',
      createdBy: userId,
    })
    .returning({ id: affiliateLinks.id });
  if (row === undefined) {
    throw new Error('affiliate link insert did not return a row');
  }
  return row;
}

function isActiveDealViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const constraint = typeof record.constraint === 'string' ? record.constraint : '';
    const message = typeof record.message === 'string' ? record.message : '';
    if (
      record.code === '23505' &&
      (constraint.includes('deals_one_active') || message.includes('deals_one_active'))
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

async function runWrite<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DealHttpError) {
      throw error;
    }
    if (isActiveDealViolation(error)) {
      throw new DealHttpError(409, ACTIVE_DEAL_MESSAGE);
    }
    throw error;
  }
}

async function requireReadable(db: DealDb, user: AuthUser, id: string): Promise<DealRow> {
  const row = await loadDeal(db, id);
  if (row === undefined || !canRead(user, row.createdBy)) {
    throw new DealHttpError(404, NOT_FOUND);
  }
  return row;
}

async function requireOwnDraft(db: DealDb, user: AuthUser, id: string): Promise<DealRow> {
  const row = await requireReadable(db, user, id);
  if (row.createdBy !== user.id) {
    throw new DealHttpError(403, OWN_DRAFT_ONLY);
  }
  if (row.status !== 'draft') {
    throw new DealHttpError(409, NOT_EDITABLE);
  }
  return row;
}

function dealValues(input: DealInput) {
  return {
    title: input.title,
    pricePaise: input.pricePaise,
    oldPricePaise: input.oldPricePaise,
    oldPriceVerified: false,
    highlights: input.highlights,
    offerText: input.offer,
    sourceNote: input.sourceNote,
    clerkNotes: input.clerkNotes,
    ...(input.previewEnabled === null ? {} : { previewEnabled: input.previewEnabled }),
  };
}

export async function checkProductUrl(
  db: DealDb,
  user: AuthUser,
  input: { url: string; pricePaise: number | null; dealId: string | null },
  amazonTag: string,
): Promise<UrlCheck> {
  const parsed = parseAmazonProductUrl(input.url, amazonTag);
  if (!parsed.ok) {
    return {
      ok: false,
      asin: null,
      problems: [parsed.message],
      code: 'invalid',
      activeDeal: false,
      repost: null,
      previousPricePaise: null,
      newPricePaise: null,
      taggedUrl: null,
      allowUnknownPriceConfirm: false,
      earlier: null,
    };
  }

  const product = await findProduct(db, parsed.asin);
  let exceptDealId: string | undefined;
  let editingOwnActive = false;
  if (input.dealId !== null) {
    const [own] = await db
      .select({
        id: deals.id,
        createdBy: deals.createdBy,
        productId: deals.productId,
        status: deals.status,
      })
      .from(deals)
      .where(eq(deals.id, input.dealId))
      .limit(1);
    if (
      own !== undefined &&
      own.createdBy === user.id &&
      product !== undefined &&
      own.productId === product.id &&
      isActiveDealStatus(own.status)
    ) {
      exceptDealId = own.id;
      editingOwnActive = true;
    }
  }
  const activeDeal =
    product === undefined ? false : await hasActiveDeal(db, product.id, exceptDealId);
  const previous = product === undefined ? null : await latestPublishedPrice(db, product.id);
  const classified = classifyUrlCheck({
    urlOk: true,
    activeDeal,
    previous,
    newPricePaise: input.pricePaise,
    editingOwnActive,
  });
  return {
    ok: true,
    asin: parsed.asin,
    problems: [],
    code: classified.code,
    activeDeal,
    repost: classified.repost,
    previousPricePaise: previous?.postedPricePaise ?? null,
    newPricePaise: input.pricePaise,
    taggedUrl: parsed.url,
    allowUnknownPriceConfirm: user.role === 'owner' && classified.code === 'posted_unknown_price',
    earlier: await earlierSummary(db, user, product?.id, exceptDealId, classified.code),
  };
}

export async function createDraft(
  db: DealDb,
  user: AuthUser,
  input: DealInput,
  amazonTag: string,
): Promise<DealJson> {
  return runWrite(() =>
    transaction(db, async (tx) => {
      const product = await prepareProduct(tx, user, input);
      const link = await insertLink(tx, input, product.id, user.id, amazonTag);
      const [created] = await tx
        .insert(deals)
        .values({
          productId: product.id,
          linkId: link.id,
          status: 'draft',
          createdBy: user.id,
          ...dealValues(input),
        })
        .returning({ id: deals.id });
      if (created === undefined) {
        throw new Error('deal insert did not return a row');
      }
      await tx.insert(auditLog).values({
        actorUserId: user.id,
        action: 'deal.create',
        entityType: 'deal',
        entityId: created.id,
        details: {
          productId: product.id,
          status: 'draft',
          ...(product.confirmedUnknownPrice ? { confirmUnknownPrice: true } : {}),
        },
      });
      const row = await loadDeal(tx, created.id);
      if (row === undefined) {
        throw new Error('deal disappeared after insert');
      }
      return toJson(row, user);
    }),
  );
}

export async function updateDraft(
  db: DealDb,
  user: AuthUser,
  id: string,
  input: DealInput,
  amazonTag: string,
): Promise<DealJson> {
  return runWrite(() =>
    transaction(db, async (tx) => {
      const current = await requireOwnDraft(tx, user, id);
      const product = await prepareProduct(tx, user, input, id);
      let linkId = current.linkId;
      if (product.id === current.productId) {
        await tx
          .update(affiliateLinks)
          .set({
            originalUrl: input.originalUrl,
            affiliateUrl: input.taggedUrl,
            shortUrl: input.shortLink,
            affiliateTag: amazonTag,
            verification: 'tag_appended',
            validationStatus: 'structure_ok',
          })
          .where(eq(affiliateLinks.id, current.linkId));
      } else {
        const link = await insertLink(tx, input, product.id, user.id, amazonTag);
        linkId = link.id;
      }
      await tx
        .update(deals)
        .set({
          productId: product.id,
          linkId,
          ...dealValues(input),
        })
        .where(eq(deals.id, id));
      await tx.insert(auditLog).values({
        actorUserId: user.id,
        action: 'deal.update',
        entityType: 'deal',
        entityId: id,
        details: {
          productId: product.id,
          status: 'draft',
          ...(product.confirmedUnknownPrice ? { confirmUnknownPrice: true } : {}),
        },
      });
      const row = await loadDeal(tx, id);
      if (row === undefined) {
        throw new Error('deal disappeared after update');
      }
      return toJson(row, user);
    }),
  );
}

export async function submitDraft(
  db: DealDb,
  user: AuthUser,
  id: string,
  now: Date,
  confirmUnknownPrice = false,
): Promise<DealJson> {
  return runWrite(() =>
    transaction(db, async (tx) => {
      const current = await requireReadable(tx, user, id);
      if (current.createdBy !== user.id) {
        throw new DealHttpError(403, OWN_DRAFT_ONLY);
      }
      if (current.status !== 'draft') {
        assertTransition(current.status, 'pending_approval');
        throw new DealHttpError(409, ONLY_DRAFT);
      }
      assertTransition(current.status, 'pending_approval');
      const fields: Record<string, string> = {};
      if (current.title === null || current.title.trim() === '') {
        fields.title = TITLE_ERROR;
      }
      if (current.productUrl.trim() === '') {
        fields.productUrl = 'Paste the product page link.';
      }
      if (Object.keys(fields).length > 0) {
        throw new DealHttpError(400, 'Check the highlighted fields.', fields);
      }
      const confirmedUnknownPrice = await assertCreatable(
        tx,
        user,
        current.productId,
        current.pricePaise,
        confirmUnknownPrice,
        id,
      );
      const updated = await tx
        .update(deals)
        .set({ status: 'pending_approval', submittedAt: now })
        .where(and(eq(deals.id, id), eq(deals.status, 'draft')))
        .returning({ id: deals.id });
      if (updated.length === 0) {
        throw new DealHttpError(409, NOT_EDITABLE);
      }
      await tx.insert(priceSnapshots).values({
        productId: current.productId,
        dealId: id,
        pricePaise: current.pricePaise,
        origin: 'clerk_entered',
        recordedBy: user.id,
        recordedAt: now,
      });
      await tx.insert(auditLog).values({
        actorUserId: user.id,
        action: 'deal.submit',
        entityType: 'deal',
        entityId: id,
        details: {
          from: 'draft',
          to: 'pending_approval',
          ...(confirmedUnknownPrice ? { confirmUnknownPrice: true } : {}),
        },
      });
      const row = await loadDeal(tx, id);
      if (row === undefined) {
        throw new Error('deal disappeared after submit');
      }
      return toJson(row, user);
    }),
  );
}

export async function withdrawDeal(db: DealDb, user: AuthUser, id: string): Promise<DealJson> {
  return transaction(db, async (tx) => {
    const current = await requireReadable(tx, user, id);
    if (current.createdBy !== user.id) {
      throw new DealHttpError(403, OWN_DRAFT_ONLY);
    }
    if (current.status !== 'pending_approval') {
      throw new DealHttpError(409, ALREADY_REVIEWED);
    }
    assertTransition(current.status, 'draft');
    const updated = await tx
      .update(deals)
      .set({ status: 'draft' })
      .where(and(eq(deals.id, id), eq(deals.status, 'pending_approval')))
      .returning({ id: deals.id });
    if (updated.length === 0) {
      throw new DealHttpError(409, ALREADY_REVIEWED);
    }
    await tx.insert(auditLog).values({
      actorUserId: user.id,
      action: 'deal.withdraw',
      entityType: 'deal',
      entityId: id,
      details: { from: 'pending_approval', to: 'draft' },
    });
    const row = await loadDeal(tx, id);
    if (row === undefined) {
      throw new Error('deal disappeared after withdraw');
    }
    return toJson(row, user);
  });
}

export async function listDeals(
  db: DealDb,
  user: AuthUser,
  status: DealStatus | undefined,
): Promise<DealJson[]> {
  const where =
    status === undefined
      ? eq(deals.createdBy, user.id)
      : and(eq(deals.createdBy, user.id), eq(deals.status, status));
  const rows = await db
    .select(dealColumns)
    .from(deals)
    .innerJoin(products, eq(products.id, deals.productId))
    .innerJoin(affiliateLinks, eq(affiliateLinks.id, deals.linkId))
    .where(where)
    .orderBy(desc(deals.updatedAt), desc(deals.createdAt));
  return rows.map((row) => toJson(row, user));
}

export async function getDeal(db: DealDb, user: AuthUser, id: string): Promise<DealJson> {
  return toJson(await requireReadable(db, user, id), user);
}

export async function setDealImage(
  db: DealDb,
  user: AuthUser,
  id: string,
  stored: { filename: string; mime: string },
): Promise<{ deal: DealJson; previousFilename: string | null }> {
  return transaction(db, async (tx) => {
    const current = await requireOwnDraft(tx, user, id);
    await tx
      .update(deals)
      .set({
        imagePath: stored.filename,
        imageMime: stored.mime,
        imageUploadedBy: user.id,
      })
      .where(eq(deals.id, id));
    await tx.insert(auditLog).values({
      actorUserId: user.id,
      action: 'deal.image_upload',
      entityType: 'deal',
      entityId: id,
      details: { mime: stored.mime },
    });
    const row = await loadDeal(tx, id);
    if (row === undefined) {
      throw new Error('deal disappeared after image upload');
    }
    return { deal: toJson(row, user), previousFilename: current.imagePath };
  });
}

export async function clearDealImage(
  db: DealDb,
  user: AuthUser,
  id: string,
): Promise<string | null> {
  return transaction(db, async (tx) => {
    const current = await requireOwnDraft(tx, user, id);
    await tx
      .update(deals)
      .set({ imagePath: null, imageMime: null, imageUploadedBy: null })
      .where(eq(deals.id, id));
    await tx.insert(auditLog).values({
      actorUserId: user.id,
      action: 'deal.image_remove',
      entityType: 'deal',
      entityId: id,
      details: {},
    });
    return current.imagePath;
  });
}

export async function openDealImage(
  db: DealDb,
  user: AuthUser,
  id: string,
  uploadDir: string,
): Promise<{ bytes: Buffer; mime: string }> {
  const row = await requireReadable(db, user, id);
  if (row.imagePath === null || row.imageMime === null || !row.imageMime.startsWith('image/')) {
    throw new DealHttpError(404, IMAGE_NONE_ERROR);
  }
  const bytes = await readStoredImage(uploadDir, row.imagePath);
  if (bytes === undefined) {
    throw new DealHttpError(404, IMAGE_NONE_ERROR);
  }
  return { bytes, mime: row.imageMime };
}

export type EarlierDeal = {
  id: string;
  dealId: string;
  title: string;
  highlights: string[];
  shortLink: string | null;
  sourceNote: string | null;
  previewEnabled: boolean;
  hasImage: boolean;
  postedAt: string | null;
  postedPrice: number | null;
};

export async function previousDeal(
  db: DealDb,
  user: AuthUser,
  query: { productId?: string; asin?: string },
): Promise<EarlierDeal> {
  const productId = query.productId?.trim() ?? '';
  const asin = query.asin?.trim() ?? '';
  if (productId.length === 0 && asin.length === 0) {
    throw new DealHttpError(400, 'Send a product id or an ASIN.');
  }
  const [row] = await db
    .select({
      id: deals.id,
      title: deals.title,
      highlights: deals.highlights,
      shortLink: affiliateLinks.shortUrl,
      sourceNote: deals.sourceNote,
      previewEnabled: deals.previewEnabled,
      imagePath: deals.imagePath,
      imageMime: deals.imageMime,
      createdBy: deals.createdBy,
      status: deals.status,
      pricePaise: deals.pricePaise,
      updatedAt: deals.updatedAt,
      postedAt: publications.publishedAt,
      postedPricePaise: publications.postedPricePaise,
    })
    .from(deals)
    .innerJoin(products, eq(products.id, deals.productId))
    .innerJoin(affiliateLinks, eq(affiliateLinks.id, deals.linkId))
    .leftJoin(
      publications,
      and(eq(publications.dealId, deals.id), eq(publications.status, 'published')),
    )
    .where(
      and(
        productId.length > 0 ? eq(deals.productId, productId) : eq(products.externalId, asin),
        or(eq(deals.createdBy, user.id), eq(deals.status, 'published'), isNotNull(publications.id)),
      ),
    )
    .orderBy(sql`${publications.publishedAt} desc nulls last`, desc(deals.updatedAt))
    .limit(1);
  if (row === undefined) {
    throw new DealHttpError(404, NOT_FOUND);
  }
  const published = row.status === 'published' || row.postedAt !== null;
  const when = row.postedAt ?? (published ? null : row.updatedAt);
  return {
    id: row.id,
    dealId: row.id,
    title: row.title,
    highlights: highlightsOf(row.highlights),
    shortLink: row.shortLink,
    sourceNote: row.sourceNote,
    previewEnabled: row.previewEnabled,
    hasImage: row.imagePath !== null && row.imageMime !== null,
    postedAt: when === null ? null : when.toISOString(),
    postedPrice: row.postedPricePaise ?? (published ? null : row.pricePaise),
  };
}

export async function assertImageCopySource(
  db: DealDb,
  user: AuthUser,
  otherDealId: string,
): Promise<string> {
  const [row] = await db
    .select({
      createdBy: deals.createdBy,
      status: deals.status,
      imagePath: deals.imagePath,
      publishedId: publications.id,
    })
    .from(deals)
    .leftJoin(
      publications,
      and(eq(publications.dealId, deals.id), eq(publications.status, 'published')),
    )
    .where(eq(deals.id, otherDealId))
    .limit(1);
  if (
    row === undefined ||
    (row.createdBy !== user.id && row.status !== 'published' && row.publishedId === null)
  ) {
    throw new DealHttpError(404, NOT_FOUND);
  }
  if (row.imagePath === null) {
    throw new DealHttpError(404, IMAGE_NONE_ERROR);
  }
  return row.imagePath;
}
