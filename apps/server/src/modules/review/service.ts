import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { paiseToRupees } from '@ss-deals/core';
import { affiliateLinks, deals, products, publications, users } from '../../db/schema/index.js';
import type { Database } from '../../lib/db.js';
import { visibleName } from '../auth/service.js';
import { evaluateRepost, type RepostDecision, type RepostReason } from '../deals/repost.js';
import { type DealStatus } from '../deals/status.js';
import { buildDealPreview, type DealPreviewResult } from './preview.js';

type ReviewDb = Database['db'];

const ACTIVE_DEAL_STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled'] as const;

export type AdminDealListItem = {
  id: string;
  title: string;
  price: number;
  oldPrice: number | null;
  oldPriceVerified: boolean;
  hasImage: boolean;
  createdBy: string;
  sourceNote: string | null;
  submittedAt: string | null;
  status: DealStatus;
  updatedAt: string;
};

export type AdminDealDetail = {
  id: string;
  status: DealStatus;
  title: string;
  price: number;
  oldPrice: number | null;
  oldPriceVerified: boolean;
  highlights: string[];
  offer: string | null;
  sourceNote: string | null;
  clerkNotes: string | null;
  reviewNote: string | null;
  rejectedReason: string | null;
  createdBy: string;
  createdById: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  asin: string;
  productAsin: string;
  productUrl: string;
  taggedUrl: string;
  taggedLink: string;
  shortLink: string | null;
  shortUrl: string | null;
  previewEnabled: boolean;
  hasImage: boolean;
  image: { url: string; mime: string } | null;
  imageUrl: string | null;
  imageMime: string | null;
  duplicate: {
    hasActiveDeal: boolean;
    activeDeal: boolean;
    repost: RepostDecision;
    allowed: boolean;
    reason: RepostReason;
    previousPostedPriceRupees: number | null;
    previousPostedPricePaise: number | null;
  };
  preview: DealPreviewResult;
};

function highlightsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

export async function listAdminDeals(
  db: ReviewDb,
  filter: {
    status?: DealStatus;
    page?: number;
    pageSize?: number;
  },
): Promise<{ counts: Record<DealStatus, number>; items: AdminDealListItem[] }> {
  const status = filter.status ?? 'pending_approval';
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, filter.pageSize ?? 20));
  const offset = (page - 1) * pageSize;

  const counts: Record<DealStatus, number> = {
    pending_approval: 0,
    approved: 0,
    draft: 0,
    rejected: 0,
    published: 0,
    failed: 0,
    scheduled: 0,
  };

  const countRows = await db
    .select({ status: deals.status, count: sql<number>`count(*)::int` })
    .from(deals)
    .groupBy(deals.status);

  for (const row of countRows) {
    if (row.status in counts) {
      counts[row.status] = Number(row.count);
    }
  }

  const query = db
    .select({
      id: deals.id,
      title: deals.title,
      pricePaise: deals.pricePaise,
      oldPricePaise: deals.oldPricePaise,
      oldPriceVerified: deals.oldPriceVerified,
      imagePath: deals.imagePath,
      imageMime: deals.imageMime,
      creatorDisplayName: users.displayName,
      creatorUsername: users.username,
      sourceNote: deals.sourceNote,
      submittedAt: deals.submittedAt,
      status: deals.status,
      updatedAt: deals.updatedAt,
      createdAt: deals.createdAt,
    })
    .from(deals)
    .innerJoin(users, eq(users.id, deals.createdBy))
    .where(eq(deals.status, status));

  if (status === 'pending_approval') {
    query.orderBy(
      sql`coalesce(${deals.submittedAt}, ${deals.createdAt}) asc`,
      asc(deals.createdAt),
      asc(deals.id),
    );
  } else {
    query.orderBy(desc(deals.updatedAt), desc(deals.createdAt), desc(deals.id));
  }

  const rows = await query.limit(pageSize).offset(offset);

  const items: AdminDealListItem[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    price: paiseToRupees(row.pricePaise),
    oldPrice: row.oldPricePaise !== null ? paiseToRupees(row.oldPricePaise) : null,
    oldPriceVerified: row.oldPriceVerified,
    hasImage: row.imagePath !== null && row.imageMime !== null,
    createdBy: visibleName(row.creatorDisplayName, row.creatorUsername),
    sourceNote: row.sourceNote,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }));

  return { counts, items };
}

export async function getAdminDeal(
  db: ReviewDb,
  id: string,
  shortLinkHosts: readonly string[],
): Promise<AdminDealDetail | undefined> {
  const [row] = await db
    .select({
      id: deals.id,
      status: deals.status,
      title: deals.title,
      pricePaise: deals.pricePaise,
      oldPricePaise: deals.oldPricePaise,
      oldPriceVerified: deals.oldPriceVerified,
      highlights: deals.highlights,
      offerText: deals.offerText,
      previewEnabled: deals.previewEnabled,
      sourceNote: deals.sourceNote,
      clerkNotes: deals.clerkNotes,
      reviewNote: deals.reviewNote,
      rejectedReason: deals.rejectedReason,
      imagePath: deals.imagePath,
      imageMime: deals.imageMime,
      productId: deals.productId,
      linkId: deals.linkId,
      externalId: products.externalId,
      originalUrl: affiliateLinks.originalUrl,
      affiliateUrl: affiliateLinks.affiliateUrl,
      shortUrl: affiliateLinks.shortUrl,
      createdById: deals.createdBy,
      creatorDisplayName: users.displayName,
      creatorUsername: users.username,
      submittedAt: deals.submittedAt,
      reviewedAt: deals.reviewedAt,
      createdAt: deals.createdAt,
      updatedAt: deals.updatedAt,
    })
    .from(deals)
    .innerJoin(products, eq(products.id, deals.productId))
    .innerJoin(affiliateLinks, eq(affiliateLinks.id, deals.linkId))
    .innerJoin(users, eq(users.id, deals.createdBy))
    .where(eq(deals.id, id))
    .limit(1);

  if (row === undefined) {
    return undefined;
  }

  const [activeDuplicate] = await db
    .select({ id: deals.id })
    .from(deals)
    .where(
      and(
        eq(deals.productId, row.productId),
        ne(deals.id, row.id),
        inArray(deals.status, [...ACTIVE_DEAL_STATUSES]),
      ),
    )
    .limit(1);
  const hasActiveDeal = activeDuplicate !== undefined;

  const [lastPublication] = await db
    .select({ postedPricePaise: publications.postedPricePaise })
    .from(publications)
    .where(and(eq(publications.productId, row.productId), eq(publications.status, 'published')))
    .orderBy(sql`${publications.publishedAt} desc nulls last`, desc(publications.createdAt))
    .limit(1);

  const repostDecision = evaluateRepost({
    previous:
      lastPublication !== undefined ? { postedPricePaise: lastPublication.postedPricePaise } : null,
    newPricePaise: row.pricePaise,
  });

  const highlights = highlightsOf(row.highlights);

  const preview = buildDealPreview(
    {
      title: row.title,
      pricePaise: row.pricePaise,
      oldPricePaise: row.oldPricePaise,
      highlights,
      offerText: row.offerText,
      shortLink: row.shortUrl,
      taggedUrl: row.affiliateUrl,
      oldPriceVerified: row.oldPriceVerified,
    },
    shortLinkHosts,
  );

  const hasImage = row.imagePath !== null && row.imageMime !== null;
  const imageUrl = hasImage ? `/api/deals/${row.id}/image` : null;

  return {
    id: row.id,
    status: row.status,
    title: row.title,
    price: paiseToRupees(row.pricePaise),
    oldPrice: row.oldPricePaise !== null ? paiseToRupees(row.oldPricePaise) : null,
    oldPriceVerified: row.oldPriceVerified,
    highlights,
    offer: row.offerText,
    sourceNote: row.sourceNote,
    clerkNotes: row.clerkNotes,
    reviewNote: row.reviewNote,
    rejectedReason: row.rejectedReason,
    createdBy: visibleName(row.creatorDisplayName, row.creatorUsername),
    createdById: row.createdById,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    asin: row.externalId,
    productAsin: row.externalId,
    productUrl: row.originalUrl,
    taggedUrl: row.affiliateUrl,
    taggedLink: row.affiliateUrl,
    shortLink: row.shortUrl,
    shortUrl: row.shortUrl,
    previewEnabled: row.previewEnabled,
    hasImage,
    image: hasImage ? { url: imageUrl!, mime: row.imageMime! } : null,
    imageUrl,
    imageMime: row.imageMime,
    duplicate: {
      hasActiveDeal,
      activeDeal: hasActiveDeal,
      repost: repostDecision,
      allowed: repostDecision.allowed,
      reason: repostDecision.reason,
      previousPostedPriceRupees:
        lastPublication?.postedPricePaise !== null &&
        lastPublication?.postedPricePaise !== undefined
          ? paiseToRupees(lastPublication.postedPricePaise)
          : null,
      previousPostedPricePaise: lastPublication?.postedPricePaise ?? null,
    },
    preview,
  };
}
