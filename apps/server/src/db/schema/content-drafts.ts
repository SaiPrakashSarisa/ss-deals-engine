import { sql } from 'drizzle-orm';
import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { deals } from './deals.js';

export const contentDraftSourceEnum = pgEnum('content_draft_source', [
  'template',
  'llm',
  'manual_edit',
]);

export const contentDrafts = pgTable(
  'content_drafts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dealId: uuid('deal_id')
      .notNull()
      .references(() => deals.id),
    version: integer('version').notNull(),
    bodyHtml: text('body_html').notNull(),
    source: contentDraftSourceEnum('source').notNull(),
    isCurrent: boolean('is_current').notNull(),
  },
  (table) => [
    unique('content_drafts_deal_version_unique').on(table.dealId, table.version),
    uniqueIndex('content_drafts_one_current_per_deal')
      .on(table.dealId)
      .where(sql`${table.isCurrent} = true`),
  ],
);
