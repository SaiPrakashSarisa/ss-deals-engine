import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { dealStatuses } from '../../modules/deals/status.js';
import { affiliateLinks } from './affiliate-links.js';
import { products } from './products.js';
import { users } from './users.js';

export const dealStatusEnum = pgEnum('deal_status', dealStatuses);

export const dealScoreClassEnum = pgEnum('deal_score_class', [
  'excellent',
  'good',
  'average',
  'not_recommended',
]);

export const deals = pgTable(
  'deals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    linkId: uuid('link_id')
      .notNull()
      .references(() => affiliateLinks.id),
    status: dealStatusEnum('status').notNull(),
    pricePaise: integer('price_paise').notNull(),
    oldPricePaise: integer('old_price_paise'),
    oldPriceVerified: boolean('old_price_verified').notNull().default(false),
    highlights: jsonb('highlights')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    offerText: text('offer_text'),
    previewEnabled: boolean('preview_enabled').notNull().default(true),
    sourceNote: text('source_note'),
    clerkNotes: text('clerk_notes'),
    reviewNote: text('review_note'),
    rejectedReason: text('rejected_reason'),
    score: integer('score'),
    scoreClass: dealScoreClassEnum('score_class'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    approvedBy: uuid('approved_by').references(() => users.id),
    /** Path to a file stored outside the database. */
    imagePath: text('image_path'),
    imageMime: text('image_mime'),
    imageUploadedBy: uuid('image_uploaded_by').references(() => users.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('deals_price_paise_positive', sql`${table.pricePaise} > 0`),
    check(
      'deals_old_price_above_price',
      sql`${table.oldPricePaise} is null or ${table.oldPricePaise} > ${table.pricePaise}`,
    ),
    check(
      'deals_old_price_verified_requires_old_price',
      sql`${table.oldPricePaise} is not null or ${table.oldPriceVerified} = false`,
    ),
    check(
      'deals_offer_text_length',
      sql`${table.offerText} is null or char_length(${table.offerText}) <= 120`,
    ),
    uniqueIndex('deals_one_active_per_product')
      .on(table.productId)
      .where(sql`${table.status} in ('draft', 'pending_approval', 'approved', 'scheduled')`),
  ],
);
