import { readFile } from 'node:fs/promises';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, ne, sql } from 'drizzle-orm';
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
  formatIstClock,
  movedMarker,
  parseRetry,
  publicationStatusLine,
  retryLastError,
} from './status-line.js';
import {
  CAPTION_TOO_LONG,
  CHANNEL_MISSING,
  DAILY_LIMIT,
  IMAGE_MISSING,
  IN_FLIGHT,
  MISSED_WINDOW,
  NO_CAPTION,
  NOT_APPROVED,
  NOT_QUEUED,
  NOT_SCHEDULED,
  NOT_UNCERTAIN,
  PUBLISHING_OFF,
  PUBLISHING_PAUSED,
  RECORD_FAILED,
  SCHEDULE_FUTURE,
  SCHEDULE_WINDOW,
  SETTINGS_INVALID,
  STOPPED_WHILE_POSTING,
  UNKNOWN_PRICE,
  WAITING_FOR_LIMIT,
} from './messages.js';
import { retryDelayMs } from './retry.js';
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
  minGapMinutes: number;
  maxLateMinutes: number;
  linkStyle: LinkStyle;
  postFooter: string;
  uploadDir: string;
  shortLinkHosts: readonly string[];
};

export type PublishActor = { id: string | null; now: Date };

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
  statusLine: string | null;
};

export type PublishOutcome = {
  publication: Omit<
    PublicationView,
    'dealId' | 'title' | 'mode' | 'origin' | 'scheduledFor' | 'createdAt' | 'statusLine'
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
  const limits = await readLimits(db, { dailyLimit: 0, minGapMinutes: 0, maxLateMinutes: 0 });
  return limits.paused;
}

const SETTING_PAUSED = 'publishing_paused';
const SETTING_LIMIT = 'daily_limit';
const SETTING_GAP = 'min_gap_minutes';

export type RuntimeLimits = {
  paused: boolean;
  dailyLimit: number;
  minGapMinutes: number;
};

export async function readLimits(
  db: PublishDb,
  defaults: Pick<PublishingSettings, 'dailyLimit' | 'minGapMinutes' | 'maxLateMinutes'>,
): Promise<RuntimeLimits & { maxLateMinutes: number }> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(inArray(settings.key, [SETTING_PAUSED, SETTING_LIMIT, SETTING_GAP]));
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const daily = stored.get(SETTING_LIMIT);
  const gap = stored.get(SETTING_GAP);
  return {
    paused: stored.get(SETTING_PAUSED) === true,
    dailyLimit:
      typeof daily === 'number' && Number.isInteger(daily) && daily >= 1 && daily <= 100
        ? daily
        : defaults.dailyLimit,
    minGapMinutes:
      typeof gap === 'number' && Number.isInteger(gap) && gap >= 0 && gap <= 1440
        ? gap
        : defaults.minGapMinutes,
    maxLateMinutes: defaults.maxLateMinutes,
  };
}

export async function publishingStatus(
  db: PublishDb,
  config: Pick<
    PublishingSettings,
    'enabled' | 'channel' | 'dailyLimit' | 'minGapMinutes' | 'maxLateMinutes'
  >,
  now: Date,
): Promise<{
  enabled: boolean;
  paused: boolean;
  dailyLimit: number;
  postedToday: number;
  channel: string | null;
  nextScheduled: string | null;
  queued: number;
  uncertain: number;
  minGapMinutes: number;
}> {
  const limits = await readLimits(db, config);
  const [counts] = await db
    .select({
      queued: sql<number>`count(*) filter (where ${publications.status} = 'queued')::int`,
      uncertain: sql<number>`count(*) filter (where ${publications.status} = 'uncertain')::int`,
      nextScheduled: sql<Date | null>`min(${publications.scheduledFor}) filter (where ${publications.status} = 'queued')`,
    })
    .from(publications);
  const next = counts?.nextScheduled ?? null;
  return {
    enabled: config.enabled,
    paused: limits.paused,
    dailyLimit: limits.dailyLimit,
    postedToday: await postedToday(db, now),
    channel: config.channel,
    nextScheduled: next instanceof Date ? next.toISOString() : null,
    queued: Number(counts?.queued ?? 0),
    uncertain: Number(counts?.uncertain ?? 0),
    minGapMinutes: limits.minGapMinutes,
  };
}

export async function listPublications(
  db: PublishDb,
  filter: { status?: string; page?: number; pageSize?: number },
  now = new Date(),
  minGapMinutes = 30,
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
      attempts: publications.attempts,
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
  const limits = await readLimits(db, {
    dailyLimit: 8,
    minGapMinutes,
    maxLateMinutes: 120,
  });
  const gapEnds = await latestGapEnd(db, now, limits.minGapMinutes);
  return {
    items: rows.map((row) => ({
      id: row.id,
      dealId: row.dealId,
      title: row.title,
      status: row.status,
      mode: row.mode,
      origin: row.origin,
      lastError: row.lastError,
      externalMessageId: row.externalMessageId,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      statusLine: publicationStatusLine({
        status: row.status,
        lastError: row.lastError,
        scheduledFor: row.scheduledFor,
        gapEnds,
        now,
      }),
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
  const prepared = await transaction(db, async (tx) =>
    prepare(tx, actor, dealId, request, deps.config),
  ).catch((error: unknown) => {
    if (uniqueViolation(error)) {
      throw new DealHttpError(409, IN_FLIGHT);
    }
    throw error;
  });

  return sendPrepared(db, actor, prepared, deps, false);
}

async function sendPrepared(
  db: PublishDb,
  actor: PublishActor,
  prepared: Prepared,
  deps: {
    client: TelegramClient;
    config: PublishingSettings;
    logger?: PublishLogger;
    beforeRecord?: (result: TelegramResult) => Promise<void>;
  },
  retryScheduled: boolean,
): Promise<PublishOutcome> {
  const logger = deps.logger ?? silentLogger;
  const channel = deps.config.channel;
  if (channel === null) {
    throw new DealHttpError(409, CHANNEL_MISSING);
  }
  let photo: { filename: string; mime: string; bytes: Uint8Array } | undefined;
  if (prepared.mode === 'photo') {
    const full =
      prepared.imagePath === null
        ? undefined
        : resolveStored(deps.config.uploadDir, prepared.imagePath);
    const bytes = full === undefined ? undefined : await readFile(full).catch(() => undefined);
    if (bytes === undefined || prepared.imageMime === null || prepared.imagePath === null) {
      await mark(db, prepared.publicationId, 'failed', IMAGE_MISSING, actor);
      if (retryScheduled) {
        await returnScheduledDeal(db, prepared.dealId);
      }
      throw new DealHttpError(409, IMAGE_MISSING);
    }
    photo = { filename: prepared.imagePath, mime: prepared.imageMime, bytes };
  }

  const result =
    photo === undefined
      ? await deps.client.sendText({
          chatId: channel,
          text: prepared.caption,
          previewEnabled: prepared.previewEnabled,
          button: prepared.button,
        })
      : await deps.client.sendPhoto({
          chatId: channel,
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
      record(tx, actor, prepared, result, deps.config.token, retryScheduled),
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
  if (
    !request.override &&
    (await postedToday(tx, actor.now)) >= (await readLimits(tx, config)).dailyLimit
  ) {
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
  retryScheduled: boolean,
): Promise<PublishOutcome> {
  const [current] = await tx
    .select({
      id: publications.id,
      dealId: publications.dealId,
      attempts: publications.attempts,
    })
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
        : result.reason;
    const safeReason = redactSecret(reason, token);
    const delay = retryScheduled ? retryDelayMs(current.attempts, result) : undefined;
    if (delay !== undefined) {
      const retryAt = new Date(actor.now.getTime() + delay);
      await tx
        .update(publications)
        .set({
          status: 'queued',
          lastError: retryLastError(retryAt, current.attempts + 1, safeReason),
        })
        .where(eq(publications.id, current.id));
    } else {
      await tx
        .update(publications)
        .set({ status: 'failed', lastError: safeReason })
        .where(eq(publications.id, current.id));
      if (deal.status === 'scheduled') {
        assertTransition(deal.status, 'approved');
        await tx.update(deals).set({ status: 'approved' }).where(eq(deals.id, deal.id));
      }
    }
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
      if (deal.status === 'scheduled') {
        assertTransition(deal.status, 'approved');
        await tx.update(deals).set({ status: 'approved' }).where(eq(deals.id, deal.id));
      }
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

export type ScheduleWarning = {
  code: 'gap' | 'limit';
  message: string;
  earliest: string;
};

export async function scheduleWarnings(
  db: PublishDb,
  at: Date,
  config: Pick<PublishingSettings, 'dailyLimit' | 'minGapMinutes' | 'maxLateMinutes'>,
  now: Date,
  exceptDealId?: string,
): Promise<ScheduleWarning[]> {
  const limits = await readLimits(db, config);
  const warnings: ScheduleWarning[] = [];
  const day = kolkataDay(at);
  const [publishedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(publications)
    .where(
      and(
        eq(publications.status, 'published'),
        eq(publications.origin, 'app'),
        gte(publications.publishedAt, day.start),
        lt(publications.publishedAt, day.end),
      ),
    );
  const queuedFilters = [
    eq(publications.status, 'queued' as const),
    gte(publications.scheduledFor, day.start),
    lt(publications.scheduledFor, day.end),
  ];
  if (exceptDealId !== undefined) {
    queuedFilters.push(ne(publications.dealId, exceptDealId));
  }
  const [queuedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(publications)
    .where(and(...queuedFilters));
  const used = Number(publishedRow?.count ?? 0) + Number(queuedRow?.count ?? 0);
  if (used >= limits.dailyLimit) {
    warnings.push({
      code: 'limit',
      message: DAILY_LIMIT,
      earliest: new Date(day.end.getTime() + limits.minGapMinutes * 60_000).toISOString(),
    });
  }
  let earliest: Date | null = null;
  const gapEnds = await latestGapEnd(db, now, limits.minGapMinutes);
  if (gapEnds !== null && at.getTime() < gapEnds.getTime()) {
    earliest = gapEnds;
  }
  const gapMs = limits.minGapMinutes * 60_000;
  if (gapMs > 0) {
    const nearbyFilters = [
      eq(publications.status, 'queued' as const),
      gte(publications.scheduledFor, new Date(at.getTime() - gapMs)),
      lte(publications.scheduledFor, new Date(at.getTime() + gapMs)),
    ];
    if (exceptDealId !== undefined) {
      nearbyFilters.push(ne(publications.dealId, exceptDealId));
    }
    const nearby = await db
      .select({ scheduledFor: publications.scheduledFor })
      .from(publications)
      .where(and(...nearbyFilters));
    for (const row of nearby) {
      if (row.scheduledFor === null) {
        continue;
      }
      const apart = Math.abs(at.getTime() - row.scheduledFor.getTime());
      const after = new Date(row.scheduledFor.getTime() + gapMs);
      if (
        apart < gapMs &&
        after.getTime() > at.getTime() &&
        (earliest === null || after > earliest)
      ) {
        earliest = after;
      }
    }
  }
  if (earliest !== null && earliest.getTime() > at.getTime()) {
    warnings.push({
      code: 'gap',
      message: `This time is inside the minimum gap. The earliest open time is ${formatIstClock(earliest)}.`,
      earliest: earliest.toISOString(),
    });
  }
  return warnings;
}

async function latestGapEnd(
  db: PublishDb,
  now: Date,
  fallbackMinutes: number,
): Promise<Date | null> {
  const limits = await readLimits(db, {
    dailyLimit: 8,
    minGapMinutes: fallbackMinutes,
    maxLateMinutes: 120,
  });
  const [last] = await db
    .select({ publishedAt: publications.publishedAt })
    .from(publications)
    .where(and(eq(publications.status, 'published'), isNotNull(publications.publishedAt)))
    .orderBy(desc(publications.publishedAt))
    .limit(1);
  if (last?.publishedAt === null || last?.publishedAt === undefined) {
    return null;
  }
  const ends = new Date(last.publishedAt.getTime() + limits.minGapMinutes * 60_000);
  return ends.getTime() > now.getTime() ? ends : null;
}
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STUCK_MS = 2 * 60 * 1000;

export type ScheduleRequest = { updatedAt: Date; scheduledFor: Date };

export type TickResult =
  | { kind: 'paused' | 'idle' | 'gap' | 'limited' | 'busy' }
  | { kind: 'missed'; count: number }
  | { kind: 'sent'; publicationId: string; status: string };

type DeliveryDeps = {
  client: TelegramClient;
  config: PublishingSettings;
  logger?: PublishLogger;
  beforeRecord?: (result: TelegramResult) => Promise<void>;
};

async function returnScheduledDeal(db: PublishDb, dealId: string): Promise<void> {
  const [deal] = await db
    .select({ status: deals.status })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  if (deal?.status !== 'scheduled') {
    return;
  }
  assertTransition(deal.status, 'approved');
  await db.update(deals).set({ status: 'approved' }).where(eq(deals.id, dealId));
}

async function writeSetting(tx: PublishDb, key: string, value: boolean | number): Promise<void> {
  await tx
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function scheduleDeal(
  db: PublishDb,
  actor: PublishActor,
  dealId: string,
  request: ScheduleRequest,
  config: PublishingSettings,
): Promise<PublishOutcome & { warnings: ScheduleWarning[] }> {
  if (!config.enabled) {
    throw new DealHttpError(409, PUBLISHING_OFF);
  }
  if (config.channel === null) {
    throw new DealHttpError(409, CHANNEL_MISSING);
  }
  if (request.scheduledFor.getTime() <= actor.now.getTime()) {
    throw new DealHttpError(400, SCHEDULE_FUTURE);
  }
  if (request.scheduledFor.getTime() > actor.now.getTime() + WEEK_MS) {
    throw new DealHttpError(400, SCHEDULE_WINDOW);
  }
  const channelName = config.channel;
  const scheduled = await transaction(db, async (tx) => {
    const [deal] = await tx
      .select({
        id: deals.id,
        status: deals.status,
        updatedAt: deals.updatedAt,
        productId: deals.productId,
        pricePaise: deals.pricePaise,
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
    if (deal.status !== 'approved' && deal.status !== 'scheduled') {
      throw new DealHttpError(409, NOT_APPROVED);
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
    const channel = await upsertChannel(tx, channelName);
    const short = deal.shortUrl?.trim() ?? '';
    const linkKind: 'short' | 'tagged' =
      short.length > 0 && validateShortLink(short, config.shortLinkHosts).ok ? 'short' : 'tagged';
    const [own] = await tx
      .select({ id: publications.id, status: publications.status })
      .from(publications)
      .where(and(eq(publications.channelId, channel.id), eq(publications.dealId, deal.id)))
      .limit(1)
      .for('update');
    if (deal.status === 'scheduled') {
      if (own === undefined || own.status !== 'queued') {
        throw new DealHttpError(409, NOT_QUEUED);
      }
      await tx
        .update(publications)
        .set({ scheduledFor: request.scheduledFor, lastError: null })
        .where(eq(publications.id, own.id));
      await tx.update(deals).set({ updatedAt: actor.now }).where(eq(deals.id, deal.id));
      await tx.insert(auditLog).values({
        actorUserId: actor.id,
        action: 'deal.schedule',
        entityType: 'deal',
        entityId: deal.id,
        details: { publicationId: own.id, scheduledFor: request.scheduledFor.toISOString() },
      });
      return outcome(tx, own.id);
    }
    if (own !== undefined && own.status !== 'failed') {
      throw new DealHttpError(409, IN_FLIGHT);
    }
    const values = {
      status: 'queued' as const,
      mode: hasImage ? ('photo' as const) : ('text' as const),
      linkKind,
      origin: 'app' as const,
      postedPricePaise: deal.pricePaise,
      attempts: 0,
      lastError: null,
      externalMessageId: null,
      publishedAt: null,
      contentDraftId: draft.id,
      scheduledFor: request.scheduledFor,
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
    assertTransition(deal.status, 'scheduled');
    await tx.update(deals).set({ status: 'scheduled' }).where(eq(deals.id, deal.id));
    await tx.insert(auditLog).values({
      actorUserId: actor.id,
      action: 'deal.schedule',
      entityType: 'deal',
      entityId: deal.id,
      details: { publicationId: row.id, scheduledFor: request.scheduledFor.toISOString() },
    });
    return outcome(tx, row.id);
  }).catch((error: unknown) => {
    if (uniqueViolation(error)) {
      throw new DealHttpError(409, IN_FLIGHT);
    }
    throw error;
  });
  return {
    ...scheduled,
    warnings: await scheduleWarnings(db, request.scheduledFor, config, actor.now, dealId),
  };
}

export async function unscheduleDeal(
  db: PublishDb,
  actor: PublishActor,
  dealId: string,
  updatedAt: Date,
  channelName: string | null,
): Promise<PublishOutcome> {
  if (channelName === null) {
    throw new DealHttpError(409, CHANNEL_MISSING);
  }
  return transaction(db, async (tx) => {
    const [deal] = await tx
      .select({ id: deals.id, status: deals.status, updatedAt: deals.updatedAt })
      .from(deals)
      .where(eq(deals.id, dealId))
      .limit(1)
      .for('update');
    if (deal === undefined) {
      throw new DealHttpError(404, 'That deal was not found.');
    }
    if (deal.updatedAt.getTime() !== updatedAt.getTime()) {
      throw new DealHttpError(409, STALE_DEAL);
    }
    if (deal.status !== 'scheduled') {
      throw new DealHttpError(409, NOT_SCHEDULED);
    }
    const [row] = await tx
      .select({ id: publications.id, status: publications.status })
      .from(publications)
      .innerJoin(channels, eq(channels.id, publications.channelId))
      .where(and(eq(publications.dealId, deal.id), eq(channels.username, channelName)))
      .limit(1)
      .for('update');
    if (row === undefined || row.status !== 'queued') {
      throw new DealHttpError(409, NOT_QUEUED);
    }
    await tx.delete(publications).where(eq(publications.id, row.id));
    assertTransition(deal.status, 'approved');
    await tx.update(deals).set({ status: 'approved' }).where(eq(deals.id, deal.id));
    await tx.insert(auditLog).values({
      actorUserId: actor.id,
      action: 'deal.unschedule',
      entityType: 'deal',
      entityId: deal.id,
      details: { publicationId: row.id },
    });
    const [saved] = await tx
      .select({ status: deals.status, updatedAt: deals.updatedAt })
      .from(deals)
      .where(eq(deals.id, deal.id))
      .limit(1);
    if (saved === undefined) {
      throw new Error('deal disappeared after unschedule');
    }
    return {
      publication: {
        id: row.id,
        dealId: deal.id,
        status: 'deleted',
        lastError: null,
        externalMessageId: null,
        publishedAt: null,
      },
      deal: { id: deal.id, status: saved.status, updatedAt: saved.updatedAt.toISOString() },
    };
  });
}

export async function setPublishingPaused(
  db: PublishDb,
  actor: PublishActor,
  paused: boolean,
): Promise<void> {
  await transaction(db, async (tx) => {
    await writeSetting(tx, SETTING_PAUSED, paused);
    await tx.insert(auditLog).values({
      actorUserId: actor.id,
      action: paused ? 'publishing.pause' : 'publishing.resume',
      entityType: 'settings',
      entityId: null,
      details: { paused },
    });
  });
}

export async function updatePublishingSettings(
  db: PublishDb,
  actor: PublishActor,
  input: { dailyLimit: number; minGapMinutes: number },
): Promise<void> {
  if (
    !Number.isInteger(input.dailyLimit) ||
    input.dailyLimit < 1 ||
    input.dailyLimit > 100 ||
    !Number.isInteger(input.minGapMinutes) ||
    input.minGapMinutes < 0 ||
    input.minGapMinutes > 1440
  ) {
    throw new DealHttpError(400, SETTINGS_INVALID);
  }
  await transaction(db, async (tx) => {
    await writeSetting(tx, SETTING_LIMIT, input.dailyLimit);
    await writeSetting(tx, SETTING_GAP, input.minGapMinutes);
    await tx.insert(auditLog).values({
      actorUserId: actor.id,
      action: 'publishing.settings',
      entityType: 'settings',
      entityId: null,
      details: { dailyLimit: input.dailyLimit, minGapMinutes: input.minGapMinutes },
    });
  });
}

export async function recoverInterruptedPublishing(db: PublishDb, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - STUCK_MS);
  const rows = await db
    .update(publications)
    .set({ status: 'uncertain', lastError: STOPPED_WHILE_POSTING })
    .where(and(eq(publications.status, 'publishing'), lt(publications.updatedAt, cutoff)))
    .returning({ id: publications.id });
  return rows.length;
}

function nextKolkataDay(now: Date, minGapMinutes: number): Date {
  return new Date(kolkataDay(now).end.getTime() + minGapMinutes * 60_000);
}

async function moveForDailyLimit(
  db: PublishDb,
  actor: PublishActor,
  maxLateMinutes: number,
  nextSlot: Date,
): Promise<void> {
  const earliest = new Date(actor.now.getTime() - maxLateMinutes * 60_000);
  const rows = await db
    .select({
      id: publications.id,
      dealId: publications.dealId,
      scheduledFor: publications.scheduledFor,
      lastError: publications.lastError,
    })
    .from(publications)
    .where(
      and(
        eq(publications.status, 'queued'),
        lte(publications.scheduledFor, actor.now),
        gte(publications.scheduledFor, earliest),
      ),
    );
  for (const row of rows) {
    if (row.scheduledFor === null || row.lastError?.startsWith('moved:')) {
      continue;
    }
    const survives = nextSlot.getTime() <= row.scheduledFor.getTime() + maxLateMinutes * 60_000;
    if (survives) {
      if (row.lastError !== WAITING_FOR_LIMIT) {
        await db
          .update(publications)
          .set({ lastError: WAITING_FOR_LIMIT })
          .where(eq(publications.id, row.id));
      }
      continue;
    }
    const original = row.scheduledFor;
    await db
      .update(publications)
      .set({ scheduledFor: nextSlot, lastError: movedMarker(original) })
      .where(eq(publications.id, row.id));
    await db.insert(auditLog).values({
      actorUserId: actor.id,
      action: 'deal.schedule',
      entityType: 'deal',
      entityId: row.dealId,
      details: {
        publicationId: row.id,
        from: original.toISOString(),
        to: nextSlot.toISOString(),
        reason: 'daily_limit',
      },
    });
  }
}

async function releaseMissed(
  db: PublishDb,
  actor: PublishActor,
  maxLateMinutes: number,
  gapEnds: Date | null,
): Promise<number> {
  const cutoff = new Date(actor.now.getTime() - maxLateMinutes * 60_000);
  return transaction(db, async (tx) => {
    const rows = await tx
      .select({
        id: publications.id,
        dealId: publications.dealId,
        lastError: publications.lastError,
      })
      .from(publications)
      .where(and(eq(publications.status, 'queued'), lt(publications.scheduledFor, cutoff)))
      .for('update');
    let missed = 0;
    for (const row of rows) {
      const retry = parseRetry(row.lastError);
      if (retry !== null && retry.at.getTime() > actor.now.getTime()) {
        continue;
      }
      if (gapEnds !== null && gapEnds.getTime() > cutoff.getTime()) {
        continue;
      }
      const [deal] = await tx
        .select({ status: deals.status })
        .from(deals)
        .where(eq(deals.id, row.dealId))
        .limit(1)
        .for('update');
      if (deal?.status === 'scheduled') {
        assertTransition(deal.status, 'approved');
        await tx
          .update(deals)
          .set({ status: 'approved', reviewNote: MISSED_WINDOW })
          .where(eq(deals.id, row.dealId));
      }
      await tx.delete(publications).where(eq(publications.id, row.id));
      await tx.insert(auditLog).values({
        actorUserId: actor.id,
        action: 'deal.unschedule',
        entityType: 'deal',
        entityId: row.dealId,
        details: { publicationId: row.id, reason: 'missed' },
      });
      missed += 1;
    }
    return missed;
  });
}

async function claimDue(
  tx: PublishDb,
  actor: PublishActor,
  config: PublishingSettings,
): Promise<Prepared | undefined> {
  if (config.channel === null) {
    return undefined;
  }
  const rows = await tx
    .select({
      id: publications.id,
      dealId: publications.dealId,
      dealStatus: deals.status,
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
      bodyHtml: contentDrafts.bodyHtml,
      lastError: publications.lastError,
    })
    .from(publications)
    .innerJoin(deals, eq(deals.id, publications.dealId))
    .innerJoin(affiliateLinks, eq(affiliateLinks.id, deals.linkId))
    .innerJoin(contentDrafts, eq(contentDrafts.id, publications.contentDraftId))
    .innerJoin(channels, eq(channels.id, publications.channelId))
    .where(
      and(
        eq(publications.status, 'queued'),
        lte(publications.scheduledFor, actor.now),
        eq(channels.username, config.channel),
      ),
    )
    .orderBy(asc(publications.scheduledFor), asc(publications.id))
    .limit(20)
    .for('update', { skipLocked: true });
  for (const row of rows) {
    const retry = parseRetry(row.lastError);
    if (retry !== null && retry.at.getTime() > actor.now.getTime()) {
      continue;
    }
    if (row.dealStatus !== 'scheduled') {
      await tx
        .update(publications)
        .set({ status: 'failed', lastError: NOT_SCHEDULED })
        .where(eq(publications.id, row.id));
      return undefined;
    }
    const hasImage = row.imagePath !== null && row.imageMime !== null;
    if (hasImage && row.bodyHtml.length >= PHOTO_CAPTION_LIMIT) {
      await tx
        .update(publications)
        .set({ status: 'failed', lastError: CAPTION_TOO_LONG(row.bodyHtml.length) })
        .where(eq(publications.id, row.id));
      assertTransition(row.dealStatus, 'approved');
      await tx.update(deals).set({ status: 'approved' }).where(eq(deals.id, row.dealId));
      return undefined;
    }
    await tx
      .update(publications)
      .set({
        status: 'publishing',
        attempts: sql`${publications.attempts} + 1`,
        postedPricePaise: row.pricePaise,
      })
      .where(eq(publications.id, row.id));
    const short = row.shortUrl?.trim() ?? '';
    const linkUrl =
      short.length > 0 && validateShortLink(short, config.shortLinkHosts).ok
        ? short
        : row.affiliateUrl;
    return {
      publicationId: row.id,
      dealId: row.dealId,
      caption: row.bodyHtml,
      previewEnabled: row.previewEnabled,
      mode: hasImage ? 'photo' : 'text',
      imagePath: row.imagePath,
      imageMime: row.imageMime,
      button: buttonFor(row, linkUrl, config),
    };
  }
  return undefined;
}

export async function publishNextDue(
  db: PublishDb,
  actor: PublishActor,
  deps: DeliveryDeps,
): Promise<TickResult> {
  await recoverInterruptedPublishing(db, actor.now);
  if (!deps.config.enabled) {
    return { kind: 'paused' };
  }
  const limits = await readLimits(db, deps.config);
  if (limits.paused) {
    return { kind: 'paused' };
  }
  const limitFull = (await postedToday(db, actor.now)) >= limits.dailyLimit;
  const gapEnds = await latestGapEnd(db, actor.now, limits.minGapMinutes);
  const gapActive = gapEnds !== null;
  if (limitFull) {
    await moveForDailyLimit(
      db,
      actor,
      limits.maxLateMinutes,
      nextKolkataDay(actor.now, limits.minGapMinutes),
    );
  }
  const missed = await releaseMissed(db, actor, limits.maxLateMinutes, gapEnds);
  if (missed > 0) {
    return { kind: 'missed', count: missed };
  }
  const [inflight] = await db
    .select({ id: publications.id })
    .from(publications)
    .where(eq(publications.status, 'publishing'))
    .limit(1);
  if (inflight !== undefined) {
    return { kind: 'busy' };
  }
  if (limitFull) {
    return { kind: 'limited' };
  }
  if (gapActive) {
    return { kind: 'gap' };
  }
  const prepared = await transaction(db, async (tx) => claimDue(tx, actor, deps.config));
  if (prepared === undefined) {
    return { kind: 'idle' };
  }
  try {
    const sent = await sendPrepared(db, actor, prepared, deps, true);
    return { kind: 'sent', publicationId: sent.publication.id, status: sent.publication.status };
  } catch (error) {
    if (error instanceof DealHttpError && error.message === IMAGE_MISSING) {
      return { kind: 'sent', publicationId: prepared.publicationId, status: 'failed' };
    }
    throw error;
  }
}
