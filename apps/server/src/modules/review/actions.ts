import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  affiliateLinks,
  auditLog,
  contentDrafts,
  deals,
  priceSnapshots,
  publications,
} from '../../db/schema/index.js';
import type { Database } from '../../lib/db.js';
import { DealHttpError } from '../deals/errors.js';
import {
  ACTIVE_DEAL_MESSAGE,
  NOT_EDITABLE,
  NOT_FOUND,
  repostRefusalMessage,
} from '../deals/messages.js';
import { evaluateRepost } from '../deals/repost.js';
import { DealStatusTransitionError, assertTransition, type DealStatus } from '../deals/status.js';
import type { ReviewEditInput } from '../deals/validation.js';
import { STALE_DEAL, UNSCHEDULE_FIRST, WITHDRAWN_DEAL } from './messages.js';
import { getAdminDeal, type AdminDealDetail } from './service.js';

type ReviewDb = Database['db'];

const ACTIVE_DEAL_STATUSES = ['draft', 'pending_approval', 'approved', 'scheduled'] as const;
const EDITABLE_STATUSES = ['pending_approval', 'approved'] as const;

type LockedDeal = {
  id: string;
  status: DealStatus;
  updatedAt: Date;
  productId: string;
  linkId: string;
  pricePaise: number;
  imagePath: string | null;
};

export type ReviewActor = {
  id: string;
  now: Date;
  shortLinkHosts: readonly string[];
};

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

async function transaction<T>(db: ReviewDb, run: (tx: ReviewDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => run(tx as unknown as ReviewDb));
}

async function loadLocked(db: ReviewDb, id: string): Promise<LockedDeal | undefined> {
  const [row] = await db
    .select({
      id: deals.id,
      status: deals.status,
      updatedAt: deals.updatedAt,
      productId: deals.productId,
      linkId: deals.linkId,
      pricePaise: deals.pricePaise,
      imagePath: deals.imagePath,
    })
    .from(deals)
    .where(eq(deals.id, id))
    .limit(1)
    .for('update');
  return row;
}

function sameInstant(stored: Date, sent: Date): boolean {
  return stored.getTime() === sent.getTime();
}

function guardEdit(row: LockedDeal, updatedAt: Date): void {
  if (!sameInstant(row.updatedAt, updatedAt)) {
    throw new DealHttpError(409, STALE_DEAL);
  }
  if (row.status === 'scheduled') {
    throw new DealHttpError(409, UNSCHEDULE_FIRST);
  }
  if (!(EDITABLE_STATUSES as readonly DealStatus[]).includes(row.status)) {
    throw new DealHttpError(409, NOT_EDITABLE);
  }
}

function guardAction(row: LockedDeal, updatedAt: Date, to: DealStatus): void {
  if (row.status === 'draft') {
    throw new DealHttpError(409, WITHDRAWN_DEAL);
  }
  if (!sameInstant(row.updatedAt, updatedAt)) {
    throw new DealHttpError(409, STALE_DEAL);
  }
  try {
    assertTransition(row.status, to);
  } catch (error) {
    if (error instanceof DealStatusTransitionError) {
      throw new DealHttpError(409, NOT_EDITABLE);
    }
    throw error;
  }
}

async function claim(
  tx: ReviewDb,
  row: LockedDeal,
  values: Partial<typeof deals.$inferInsert>,
): Promise<void> {
  const saved = await tx
    .update(deals)
    .set(values)
    .where(and(eq(deals.id, row.id), eq(deals.status, row.status)))
    .returning({ id: deals.id });
  if (saved.length > 0) {
    return;
  }
  const again = await loadLocked(tx, row.id);
  if (again === undefined) {
    throw new DealHttpError(404, NOT_FOUND);
  }
  if (again.status === 'draft') {
    throw new DealHttpError(409, WITHDRAWN_DEAL);
  }
  throw new DealHttpError(409, STALE_DEAL);
}

async function audit(
  tx: ReviewDb,
  actorId: string,
  action: string,
  dealId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLog).values({
    actorUserId: actorId,
    action,
    entityType: 'deal',
    entityId: dealId,
    details,
  });
}

async function storeCaption(tx: ReviewDb, dealId: string, caption: string): Promise<void> {
  const [latest] = await tx
    .select({ version: contentDrafts.version })
    .from(contentDrafts)
    .where(eq(contentDrafts.dealId, dealId))
    .orderBy(desc(contentDrafts.version))
    .limit(1);
  await tx
    .update(contentDrafts)
    .set({ isCurrent: false })
    .where(and(eq(contentDrafts.dealId, dealId), eq(contentDrafts.isCurrent, true)));
  await tx.insert(contentDrafts).values({
    dealId,
    version: (latest?.version ?? 0) + 1,
    bodyHtml: caption,
    source: 'template',
    isCurrent: true,
  });
}

async function refreshApprovedCaption(
  tx: ReviewDb,
  dealId: string,
  shortLinkHosts: readonly string[],
): Promise<void> {
  const detail = await getAdminDeal(tx, dealId, shortLinkHosts);
  if (detail === undefined) {
    throw new Error('deal disappeared before the caption was saved');
  }
  if (detail.status !== 'approved') {
    return;
  }
  if (!detail.preview.ok) {
    throw new DealHttpError(409, detail.preview.message);
  }
  await storeCaption(tx, dealId, detail.preview.caption);
}

async function requireDetail(
  tx: ReviewDb,
  id: string,
  shortLinkHosts: readonly string[],
): Promise<AdminDealDetail> {
  const detail = await getAdminDeal(tx, id, shortLinkHosts);
  if (detail === undefined) {
    throw new Error('deal disappeared after review update');
  }
  return detail;
}

async function hasOtherActive(tx: ReviewDb, productId: string, dealId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: deals.id })
    .from(deals)
    .where(
      and(
        eq(deals.productId, productId),
        ne(deals.id, dealId),
        inArray(deals.status, [...ACTIVE_DEAL_STATUSES]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function assertRepostAllowed(
  tx: ReviewDb,
  productId: string,
  pricePaise: number,
): Promise<void> {
  const [lastPublication] = await tx
    .select({ postedPricePaise: publications.postedPricePaise })
    .from(publications)
    .where(and(eq(publications.productId, productId), eq(publications.status, 'published')))
    .orderBy(sql`${publications.publishedAt} desc nulls last`, desc(publications.createdAt))
    .limit(1);
  const decision = evaluateRepost({
    previous:
      lastPublication === undefined ? null : { postedPricePaise: lastPublication.postedPricePaise },
    newPricePaise: pricePaise,
  });
  if (decision.reason === 'previous_price_unknown') {
    return;
  }
  if (!decision.allowed && decision.reason !== 'first_post') {
    throw new DealHttpError(409, repostRefusalMessage('price_not_lower'));
  }
}

export async function updateAdminDeal(
  db: ReviewDb,
  actor: ReviewActor,
  id: string,
  input: ReviewEditInput,
): Promise<AdminDealDetail> {
  return runWrite(() =>
    transaction(db, async (tx) => {
      const current = await loadLocked(tx, id);
      if (current === undefined) {
        throw new DealHttpError(404, NOT_FOUND);
      }
      guardEdit(current, input.updatedAt);
      await tx
        .update(affiliateLinks)
        .set({ shortUrl: input.shortLink })
        .where(eq(affiliateLinks.id, current.linkId));
      await claim(tx, current, {
        title: input.title,
        pricePaise: input.pricePaise,
        oldPricePaise: input.oldPricePaise,
        oldPriceVerified: input.oldPriceVerified,
        highlights: input.highlights,
        offerText: input.offer,
        sourceNote: input.sourceNote,
        previewEnabled: input.previewEnabled,
      });
      if (input.pricePaise !== current.pricePaise) {
        await tx.insert(priceSnapshots).values({
          productId: current.productId,
          dealId: id,
          pricePaise: input.pricePaise,
          origin: 'owner_entered',
          recordedBy: actor.id,
          recordedAt: actor.now,
        });
      }
      await refreshApprovedCaption(tx, id, actor.shortLinkHosts);
      await audit(tx, actor.id, 'deal.admin_update', id, {
        from: current.status,
        priceChanged: input.pricePaise !== current.pricePaise,
      });
      return requireDetail(tx, id, actor.shortLinkHosts);
    }),
  );
}

export async function replaceAdminImage(
  db: ReviewDb,
  actor: ReviewActor,
  id: string,
  updatedAt: Date,
  stored: { filename: string; mime: string },
): Promise<{ deal: AdminDealDetail; previousFilename: string | null }> {
  return runWrite(() =>
    transaction(db, async (tx) => {
      const current = await loadLocked(tx, id);
      if (current === undefined) {
        throw new DealHttpError(404, NOT_FOUND);
      }
      guardEdit(current, updatedAt);
      await claim(tx, current, {
        imagePath: stored.filename,
        imageMime: stored.mime,
        imageUploadedBy: actor.id,
      });
      await refreshApprovedCaption(tx, id, actor.shortLinkHosts);
      await audit(tx, actor.id, 'deal.admin_image_upload', id, { mime: stored.mime });
      return {
        deal: await requireDetail(tx, id, actor.shortLinkHosts),
        previousFilename: current.imagePath,
      };
    }),
  );
}

export async function removeAdminImage(
  db: ReviewDb,
  actor: ReviewActor,
  id: string,
  updatedAt: Date,
): Promise<{ deal: AdminDealDetail; previousFilename: string | null }> {
  return runWrite(() =>
    transaction(db, async (tx) => {
      const current = await loadLocked(tx, id);
      if (current === undefined) {
        throw new DealHttpError(404, NOT_FOUND);
      }
      guardEdit(current, updatedAt);
      await claim(tx, current, {
        imagePath: null,
        imageMime: null,
        imageUploadedBy: null,
      });
      await refreshApprovedCaption(tx, id, actor.shortLinkHosts);
      await audit(tx, actor.id, 'deal.admin_image_remove', id, {});
      return {
        deal: await requireDetail(tx, id, actor.shortLinkHosts),
        previousFilename: current.imagePath,
      };
    }),
  );
}

async function moveStatus(
  db: ReviewDb,
  actor: ReviewActor,
  id: string,
  updatedAt: Date,
  to: DealStatus,
  values: Partial<typeof deals.$inferInsert>,
  action: string,
): Promise<AdminDealDetail> {
  return runWrite(() =>
    transaction(db, async (tx) => {
      const current = await loadLocked(tx, id);
      if (current === undefined) {
        throw new DealHttpError(404, NOT_FOUND);
      }
      guardAction(current, updatedAt, to);
      if (to === 'approved' || to === 'pending_approval') {
        if (await hasOtherActive(tx, current.productId, id)) {
          throw new DealHttpError(409, ACTIVE_DEAL_MESSAGE);
        }
      }
      if (to === 'approved') {
        await assertRepostAllowed(tx, current.productId, current.pricePaise);
        const preview = await getAdminDeal(tx, id, actor.shortLinkHosts);
        if (preview === undefined) {
          throw new DealHttpError(404, NOT_FOUND);
        }
        if (!preview.preview.ok) {
          throw new DealHttpError(409, preview.preview.message);
        }
        await claim(tx, current, { ...values, status: to });
        await storeCaption(tx, id, preview.preview.caption);
      } else {
        await claim(tx, current, { ...values, status: to });
      }
      await audit(tx, actor.id, action, id, { from: current.status, to });
      return requireDetail(tx, id, actor.shortLinkHosts);
    }),
  );
}

export async function approveDeal(
  db: ReviewDb,
  actor: ReviewActor,
  id: string,
  updatedAt: Date,
): Promise<AdminDealDetail> {
  return moveStatus(
    db,
    actor,
    id,
    updatedAt,
    'approved',
    { approvedBy: actor.id, reviewedAt: actor.now },
    'deal.approve',
  );
}

export async function sendDealBack(
  db: ReviewDb,
  actor: ReviewActor,
  id: string,
  updatedAt: Date,
  note: string,
): Promise<AdminDealDetail> {
  return moveStatus(
    db,
    actor,
    id,
    updatedAt,
    'draft',
    { reviewNote: note, reviewedAt: actor.now },
    'deal.send_back',
  );
}

export async function rejectDeal(
  db: ReviewDb,
  actor: ReviewActor,
  id: string,
  updatedAt: Date,
  reason: string,
): Promise<AdminDealDetail> {
  return moveStatus(
    db,
    actor,
    id,
    updatedAt,
    'rejected',
    { rejectedReason: reason, reviewedAt: actor.now },
    'deal.reject',
  );
}

export async function reopenDeal(
  db: ReviewDb,
  actor: ReviewActor,
  id: string,
  updatedAt: Date,
): Promise<AdminDealDetail> {
  return moveStatus(
    db,
    actor,
    id,
    updatedAt,
    'pending_approval',
    { rejectedReason: null },
    'deal.reopen',
  );
}

export async function unapproveDeal(
  db: ReviewDb,
  actor: ReviewActor,
  id: string,
  updatedAt: Date,
): Promise<AdminDealDetail> {
  return moveStatus(
    db,
    actor,
    id,
    updatedAt,
    'pending_approval',
    { approvedBy: null },
    'deal.unapprove',
  );
}
