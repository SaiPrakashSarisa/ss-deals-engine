import { readFile } from 'node:fs/promises';
import { and, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  AMAZON_BUTTON_LABEL,
  formatPost,
  paiseToRupees,
  validateShortLink,
  type LinkStyle,
} from '@ss-deals/core';
import {
  affiliateLinks,
  auditLog,
  channels,
  contentDrafts,
  deals,
  publications,
  settings,
} from '../../db/schema/index.js';
import type { Database } from '../../lib/db.js';
import { DealHttpError } from '../deals/errors.js';
import { repostRefusalMessage } from '../deals/messages.js';
import { evaluateRepost } from '../deals/repost.js';
import { assertTransition, type DealStatus } from '../deals/status.js';
import { STALE_DEAL } from '../review/messages.js';
import { resolveStored } from '../uploads/files.js';
import {
  CAPTION_TOO_LONG,
  CHANNEL_MISSING,
  DAILY_LIMIT,
  IMAGE_MISSING,
  IN_FLIGHT,
  NO_CAPTION,
  NOT_APPROVED,
  NOT_UNCERTAIN,
  PUBLISHING_OFF,
  PUBLISHING_PAUSED,
  RECORD_FAILED,
  UNKNOWN_PRICE,
} from './messages.js';
import {
  redactSecret,
  type TelegramButton,
  type TelegramClient,
  type TelegramResult,
} from './telegram.js';

type PublishDb = Database['db'];

const BLOCKING = ['queued', 'publishing', 'uncertain'] as const;
const PHOTO_CAPTION_LIMIT = 1024;

export type PublishLogger = {
  error: (fields: Record<string, unknown>, message: string) => void;
};

export type PublishingSettings = {
  enabled: boolean;
  channel: string | null;
  token: string | null;
  dailyLimit: number;
  linkStyle: LinkStyle;
  postFooter: string;
  uploadDir: string;
  shortLinkHosts: readonly string[];
};

export type PublishActor = { id: string; now: Date };

export type PublishRequest = {
  updatedAt: Date;
  override: boolean;
  confirmUnknownPrice: boolean;
};

export type PublicationView = {
  id: string;
  dealId: string;
  title: string;
  status: string;
  mode: string;
  origin: string;
  lastError: string | null;
  externalMessageId: string | null;
  publishedAt: string | null;
  scheduledFor: string | null;
  createdAt: string;
};

export type PublishOutcome = {
  publication: Omit<
    PublicationView,
    'dealId' | 'title' | 'mode' | 'origin' | 'scheduledFor' | 'createdAt'
  > & {
    dealId: string;
  };
  deal: { id: string; status: DealStatus; updatedAt: string };
};

const silentLogger: PublishLogger = { error() {} };

function kolkataDay(now: Date): { start: Date; end: Date } {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const start = new Date(`${day}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

async function transaction<T>(db: PublishDb, run: (tx: PublishDb) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => run(tx as unknown as PublishDb));
}

function uniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === 'object' && current !== null; depth += 1) {
    const record = current as { code?: unknown; cause?: unknown };
    if (record.code === '23505') {
      return true;
    }
    current = record.cause;
  }
  return false;
}

async function postedToday(db: PublishDb, now: Date): Promise<number> {
  const bounds = kolkataDay(now);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(publications)
    .where(
      and(
        eq(publications.status, 'published'),
        eq(publications.origin, 'app'),
        gte(publications.publishedAt, bounds.start),
        lt(publications.publishedAt, bounds.end),
      ),
    );
  return Number(row?.count ?? 0);
}

async function isPaused(db: PublishDb): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'publishing_paused'))
    .limit(1);
  return row?.value === true;
}

export async function publishingStatus(
  db: PublishDb,
  config: Pick<PublishingSettings, 'enabled' | 'channel' | 'dailyLimit'>,
  now: Date,
): Promise<{
  enabled: boolean;
  paused: boolean;
  dailyLimit: number;
  postedToday: number;
  channel: string | null;
}> {
  return {
    enabled: config.enabled,
    paused: await isPaused(db),
    dailyLimit: config.dailyLimit,
    postedToday: await postedToday(db, now),
    channel: config.channel,
  };
}

export async function listPublications(
  db: PublishDb,
  filter: { status?: string; page?: number; pageSize?: number },
): Promise<{ items: PublicationView[] }> {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(50, Math.max(1, filter.pageSize ?? 20));
  const statuses = ['queued', 'publishing', 'published', 'failed', 'uncertain'] as const;
  const status = statuses.find((item) => item === filter.status);
  const rows = await db
    .select({
      id: publications.id,
      dealId: publications.dealId,
      title: deals.title,
      status: publications.status,
      mode: publications.mode,
      origin: publications.origin,
      lastError: publications.lastError,
      externalMessageId: publications.externalMessageId,
      publishedAt: publications.publishedAt,
      scheduledFor: publications.scheduledFor,
      createdAt: publications.createdAt,
    })
    .from(publications)
    .innerJoin(deals, eq(deals.id, publications.dealId))
    .where(status === undefined ? undefined : eq(publications.status, status))
    .orderBy(desc(publications.createdAt), desc(publications.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    items: rows.map((row) => ({
      ...row,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

type Prepared = {
  publicationId: string;
  dealId: string;
  caption: string;
  previewEnabled: boolean;
  mode: 'text' | 'photo';
  imagePath: string | null;
  imageMime: string | null;
  button?: TelegramButton;
};

export async function publishDeal(
  db: PublishDb,
  actor: PublishActor,
  dealId: string,
  request: PublishRequest,
  deps: {
    client: TelegramClient;
    config: PublishingSettings;
    logger?: PublishLogger;
    beforeRecord?: (result: TelegramResult) => Promise<void>;
  },
): Promise<PublishOutcome> {
  if (!deps.config.enabled) {
    throw new DealHttpError(409, PUBLISHING_OFF);
  }
  if (deps.config.channel === null) {
    throw new DealHttpError(409, CHANNEL_MISSING);
  }
  const logger = deps.logger ?? silentLogger;
  const prepared = await transaction(db, async (tx) =>
    prepare(tx, actor, dealId, request, deps.config),
  ).catch((error: unknown) => {
    if (uniqueViolation(error)) {
      throw new DealHttpError(409, IN_FLIGHT);
    }
    throw error;
  });

  let photo: { filename: string; mime: string; bytes: Uint8Array } | undefined;
  if (prepared.mode === 'photo') {
    const full =
      prepared.imagePath === null
        ? undefined
        : resolveStored(deps.config.uploadDir, prepared.imagePath);
    const bytes = full === undefined ? undefined : await readFile(full).catch(() => undefined);
    if (bytes === undefined || prepared.imageMime === null || prepared.imagePath === null) {
      await mark(db, prepared.publicationId, 'failed', IMAGE_MISSING, actor);
      throw new DealHttpError(409, IMAGE_MISSING);
    }
    photo = { filename: prepared.imagePath, mime: prepared.imageMime, bytes };
  }

  const result =
    photo === undefined
      ? await deps.client.sendText({
          chatId: deps.config.channel,
          text: prepared.caption,
          previewEnabled: prepared.previewEnabled,
          button: prepared.button,
        })
      : await deps.client.sendPhoto({
          chatId: deps.config.channel,
          caption: prepared.caption,
          filename: photo.filename,
          mime: photo.mime,
          bytes: photo.bytes,
          button: prepared.button,
        });

  try {
    if (deps.beforeRecord !== undefined) {
      await deps.beforeRecord(result);
    }
    return await transaction(db, async (tx) =>
      record(tx, actor, prepared, result, deps.config.token),
    );
  } catch (error) {
    if (result.kind === 'ok') {
      logger.error(
        { messageId: result.messageId, publicationId: prepared.publicationId },
        'telegram accepted the post but the database update failed',
      );
      throw new DealHttpError(500, RECORD_FAILED);
    }
    throw error;
  }
}

async function prepare(
  tx: PublishDb,
  actor: PublishActor,
  dealId: string,
  request: PublishRequest,
  config: PublishingSettings,
): Promise<Prepared> {
  const channelName = config.channel;
  if (channelName === null) {
    throw new DealHttpError(409, CHANNEL_MISSING);
  }
  const [deal] = await tx
    .select({
      id: deals.id,
      status: deals.status,
      updatedAt: deals.updatedAt,
      productId: deals.productId,
      title: deals.title,
      pricePaise: deals.pricePaise,
      oldPricePaise: deals.oldPricePaise,
      oldPriceVerified: deals.oldPriceVerified,
      highlights: deals.highlights,
      offerText: deals.offerText,
      previewEnabled: deals.previewEnabled,
      imagePath: deals.imagePath,
      imageMime: deals.imageMime,
      shortUrl: affiliateLinks.shortUrl,
      affiliateUrl: affiliateLinks.affiliateUrl,
    })
    .from(deals)
    .innerJoin(affiliateLinks, eq(affiliateLinks.id, deals.linkId))
    .where(eq(deals.id, dealId))
    .limit(1)
    .for('update');
  if (deal === undefined) {
    throw new DealHttpError(404, 'That deal was not found.');
  }
  if (deal.updatedAt.getTime() !== request.updatedAt.getTime()) {
    throw new DealHttpError(409, STALE_DEAL);
  }
  if (deal.status !== 'approved') {
    throw new DealHttpError(409, NOT_APPROVED);
  }
  if (await isPaused(tx)) {
    throw new DealHttpError(409, PUBLISHING_PAUSED);
  }
  const [draft] = await tx
    .select({ id: contentDrafts.id, bodyHtml: contentDrafts.bodyHtml })
    .from(contentDrafts)
    .where(and(eq(contentDrafts.dealId, deal.id), eq(contentDrafts.isCurrent, true)))
    .limit(1);
  if (draft === undefined) {
    throw new DealHttpError(409, NO_CAPTION);
  }
  const hasImage = deal.imagePath !== null && deal.imageMime !== null;
  if (hasImage && draft.bodyHtml.length >= PHOTO_CAPTION_LIMIT) {
    throw new DealHttpError(409, CAPTION_TOO_LONG(draft.bodyHtml.length));
  }

  const [previous] = await tx
    .select({ postedPricePaise: publications.postedPricePaise })
    .from(publications)
    .where(and(eq(publications.productId, deal.productId), eq(publications.status, 'published')))
    .orderBy(sql`${publications.publishedAt} desc nulls last`, desc(publications.createdAt))
    .limit(1);
  const repost = evaluateRepost({
    previous: previous === undefined ? null : { postedPricePaise: previous.postedPricePaise },
    newPricePaise: deal.pricePaise,
  });
  if (repost.reason === 'previous_price_unknown') {
    if (!(request.override && request.confirmUnknownPrice)) {
      throw new DealHttpError(409, UNKNOWN_PRICE);
    }
  } else if (!repost.allowed) {
    throw new DealHttpError(409, repostRefusalMessage('price_not_lower'));
  }
  if (!request.override && (await postedToday(tx, actor.now)) >= config.dailyLimit) {
    throw new DealHttpError(409, DAILY_LIMIT);
  }

  const channel = await upsertChannel(tx, channelName);
  const [inflight] = await tx
    .select({ id: publications.id })
    .from(publications)
    .where(
      and(
        eq(publications.channelId, channel.id),
        eq(publications.productId, deal.productId),
        inArray(publications.status, [...BLOCKING]),
        ne(publications.dealId, deal.id),
      ),
    )
    .limit(1);
  if (inflight !== undefined) {
    throw new DealHttpError(409, IN_FLIGHT);
  }

  const short = deal.shortUrl?.trim() ?? '';
  const linkKind: 'short' | 'tagged' =
    short.length > 0 && validateShortLink(short, config.shortLinkHosts).ok ? 'short' : 'tagged';
  const linkUrl = linkKind === 'short' ? short : deal.affiliateUrl;
  const button = buttonFor(deal, linkUrl, config);
  const [own] = await tx
    .select({ id: publications.id, status: publications.status })
    .from(publications)
    .where(and(eq(publications.channelId, channel.id), eq(publications.dealId, deal.id)))
    .limit(1)
    .for('update');
  if (own !== undefined && own.status !== 'failed') {
    throw new DealHttpError(409, IN_FLIGHT);
  }

  const values = {
    status: 'publishing' as const,
    mode: hasImage ? ('photo' as const) : ('text' as const),
    linkKind,
    origin: 'app' as const,
    postedPricePaise: deal.pricePaise,
    attempts: 1,
    lastError: null,
    externalMessageId: null,
    publishedAt: null,
    contentDraftId: draft.id,
    scheduledFor: null,
  };
  const row =
    own === undefined
      ? (
          await tx
            .insert(publications)
            .values({
              ...values,
              dealId: deal.id,
              productId: deal.productId,
              channelId: channel.id,
            })
            .returning({ id: publications.id })
        )[0]
      : (
          await tx
            .update(publications)
            .set(values)
            .where(eq(publications.id, own.id))
            .returning({ id: publications.id })
        )[0];
  if (row === undefined) {
    throw new DealHttpError(409, IN_FLIGHT);
  }
  await tx.insert(auditLog).values({
    actorUserId: actor.id,
    action: 'deal.publish',
    entityType: 'deal',
    entityId: deal.id,
    details: { publicationId: row.id, phase: 'started' },
  });
  return {
    publicationId: row.id,
    dealId: deal.id,
    caption: draft.bodyHtml,
    previewEnabled: deal.previewEnabled,
    mode: values.mode,
    imagePath: deal.imagePath,
    imageMime: deal.imageMime,
    button,
  };
}

function buttonFor(
  deal: {
    title: string;
    pricePaise: number;
    oldPricePaise: number | null;
    oldPriceVerified: boolean;
    highlights: string[];
    offerText: string | null;
  },
  linkUrl: string,
  config: PublishingSettings,
): TelegramButton | undefined {
  if (config.linkStyle === 'text') {
    return undefined;
  }
  const oldPrice = deal.oldPricePaise === null ? undefined : paiseToRupees(deal.oldPricePaise);
  const price = paiseToRupees(deal.pricePaise);
  const formatted = formatPost({
    title: deal.title,
    price,
    oldPrice: oldPrice !== undefined && oldPrice > price ? oldPrice : undefined,
    verified: deal.oldPriceVerified && oldPrice !== undefined && oldPrice > price,
    highlights: deal.highlights.filter((item) => item.trim().length > 0),
    offer: deal.offerText?.trim() || undefined,
    linkUrl,
    linkStyle: config.linkStyle,
    footer: config.postFooter.length > 0 ? config.postFooter : undefined,
  });
  if (!formatted.ok || formatted.urlButton === undefined) {
    return { text: AMAZON_BUTTON_LABEL, url: linkUrl };
  }
  return formatted.urlButton;
}

async function upsertChannel(tx: PublishDb, username: string) {
  const found = async () => {
    const [existing] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.platform, 'telegram'), eq(channels.username, username)))
      .limit(1);
    return existing;
  };
  const existing = await found();
  if (existing !== undefined) {
    return existing;
  }
  try {
    const [created] = await tx
      .insert(channels)
      .values({ platform: 'telegram', name: username, username, isActive: true })
      .returning({ id: channels.id });
    if (created === undefined) {
      throw new DealHttpError(409, CHANNEL_MISSING);
    }
    return created;
  } catch (error) {
    if (!uniqueViolation(error)) {
      throw error;
    }
    const again = await found();
    if (again === undefined) {
      throw error;
    }
    return again;
  }
}

async function mark(
  db: PublishDb,
  publicationId: string,
  status: 'failed',
  lastError: string,
  actor: PublishActor,
): Promise<void> {
  await db
    .update(publications)
    .set({ status, lastError })
    .where(eq(publications.id, publicationId));
  await db.insert(auditLog).values({
    actorUserId: actor.id,
    action: 'deal.publish',
    entityType: 'publication',
    entityId: publicationId,
    details: { status },
  });
}

async function record(
  tx: PublishDb,
  actor: PublishActor,
  prepared: Prepared,
  result: TelegramResult,
  token: string | null,
): Promise<PublishOutcome> {
  const [current] = await tx
    .select({ id: publications.id, dealId: publications.dealId })
    .from(publications)
    .where(eq(publications.id, prepared.publicationId))
    .limit(1)
    .for('update');
  if (current === undefined) {
    throw new Error('publication row disappeared');
  }
  const [deal] = await tx
    .select({ id: deals.id, status: deals.status })
    .from(deals)
    .where(eq(deals.id, current.dealId))
    .limit(1)
    .for('update');
  if (deal === undefined) {
    throw new DealHttpError(404, 'That deal was not found.');
  }

  if (result.kind === 'ok') {
    assertTransition(deal.status, 'published');
    await tx
      .update(publications)
      .set({
        status: 'published',
        externalMessageId: String(result.messageId),
        publishedAt: actor.now,
        lastError: null,
      })
      .where(eq(publications.id, current.id));
    await tx
      .update(deals)
      .set({ status: 'published' })
      .where(and(eq(deals.id, deal.id), eq(deals.status, deal.status)));
  } else if (result.kind === 'uncertain') {
    await tx
      .update(publications)
      .set({ status: 'uncertain', lastError: redactSecret(result.reason, token) })
      .where(eq(publications.id, current.id));
  } else {
    const reason =
      result.kind === 'rate_limited'
        ? `Telegram rate limit. Retry after ${result.retryAfterSeconds} seconds.`
        : result.kind === 'not_sent'
          ? result.reason
          : result.reason;
    await tx
      .update(publications)
      .set({ status: 'failed', lastError: redactSecret(reason, token) })
      .where(eq(publications.id, current.id));
  }

  await tx.insert(auditLog).values({
    actorUserId: actor.id,
    action: 'deal.publish',
    entityType: 'deal',
    entityId: deal.id,
    details: { publicationId: current.id, result: result.kind },
  });
  return outcome(tx, current.id);
}

async function outcome(tx: PublishDb, publicationId: string): Promise<PublishOutcome> {
  const [row] = await tx
    .select({
      id: publications.id,
      dealId: publications.dealId,
      status: publications.status,
      lastError: publications.lastError,
      externalMessageId: publications.externalMessageId,
      publishedAt: publications.publishedAt,
      dealStatus: deals.status,
      updatedAt: deals.updatedAt,
    })
    .from(publications)
    .innerJoin(deals, eq(deals.id, publications.dealId))
    .where(eq(publications.id, publicationId))
    .limit(1);
  if (row === undefined) {
    throw new Error('publication row disappeared');
  }
  return {
    publication: {
      id: row.id,
      dealId: row.dealId,
      status: row.status,
      lastError: row.lastError,
      externalMessageId: row.externalMessageId,
      publishedAt: row.publishedAt?.toISOString() ?? null,
    },
    deal: { id: row.dealId, status: row.dealStatus, updatedAt: row.updatedAt.toISOString() },
  };
}

export async function resolvePublication(
  db: PublishDb,
  actor: PublishActor,
  publicationId: string,
  input: { outcome: 'posted' | 'not_posted'; messageId?: string },
): Promise<PublishOutcome> {
  return transaction(db, async (tx) => {
    const [row] = await tx
      .select({
        id: publications.id,
        status: publications.status,
        dealId: publications.dealId,
        externalMessageId: publications.externalMessageId,
      })
      .from(publications)
      .where(eq(publications.id, publicationId))
      .limit(1)
      .for('update');
    if (row === undefined) {
      throw new DealHttpError(404, 'That post was not found.');
    }
    if (row.status !== 'uncertain') {
      throw new DealHttpError(409, NOT_UNCERTAIN);
    }
    const [deal] = await tx
      .select({ id: deals.id, status: deals.status })
      .from(deals)
      .where(eq(deals.id, row.dealId))
      .limit(1)
      .for('update');
    if (deal === undefined) {
      throw new DealHttpError(404, 'That deal was not found.');
    }
    if (input.outcome === 'posted') {
      assertTransition(deal.status, 'published');
      await tx
        .update(publications)
        .set({
          status: 'published',
          externalMessageId: input.messageId ?? row.externalMessageId,
          publishedAt: actor.now,
          lastError: null,
        })
        .where(eq(publications.id, row.id));
      await tx.update(deals).set({ status: 'published' }).where(eq(deals.id, deal.id));
    } else {
      await tx
        .update(publications)
        .set({ status: 'failed', lastError: 'Marked as not posted.' })
        .where(eq(publications.id, row.id));
    }
    await tx.insert(auditLog).values({
      actorUserId: actor.id,
      action: 'publication.resolve',
      entityType: 'publication',
      entityId: row.id,
      details: { outcome: input.outcome },
    });
    return outcome(tx, row.id);
  });
}
