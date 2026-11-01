import { sql } from 'drizzle-orm';
import {
  foreignKey,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { channels } from './channels.js';
import { contentDrafts } from './content-drafts.js';
import { deals } from './deals.js';
import { products } from './products.js';

export const publicationStatusEnum = pgEnum('publication_status', [
  'queued',
  'publishing',
  'published',
  'failed',
  'uncertain',
]);

export const publicationModeEnum = pgEnum('publication_mode', ['text', 'photo']);

export const publicationLinkKindEnum = pgEnum('publication_link_kind', ['tagged', 'short']);

export const publicationOriginEnum = pgEnum('publication_origin', ['app', 'quickpost_import']);

export const publications = pgTable(
  'publications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id),
    contentDraftId: uuid('content_draft_id')
      .notNull()
      .references(() => contentDrafts.id),
    status: publicationStatusEnum('status').notNull(),
    mode: publicationModeEnum('mode').notNull().default('text'),
    linkKind: publicationLinkKindEnum('link_kind').notNull().default('tagged'),
    origin: publicationOriginEnum('origin').notNull().default('app'),
    postedPricePaise: integer('posted_price_paise'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    externalMessageId: text('external_message_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'publications_deal_product_deals_fk',
      columns: [table.dealId, table.productId],
      foreignColumns: [deals.id, deals.productId],
    }),
    unique('publications_channel_deal_unique').on(table.channelId, table.dealId),
    uniqueIndex('publications_one_inflight_per_channel_product')
      .on(table.channelId, table.productId)
      .where(sql`${table.status} in ('queued', 'publishing', 'uncertain')`),
  ],
);
