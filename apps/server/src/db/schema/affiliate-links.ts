import { index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { products } from './products.js';
import { users } from './users.js';

export const affiliateVerificationEnum = pgEnum('affiliate_link_verification', [
  'api_generated',
  'sitestripe_manual',
  'network_deeplink_manual',
  'tag_appended',
]);

export const affiliateValidationStatusEnum = pgEnum('affiliate_link_validation_status', [
  'unvalidated',
  'structure_ok',
  'invalid',
]);

export const affiliateLinks = pgTable(
  'affiliate_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    platform: text('platform').notNull(),
    originalUrl: text('original_url').notNull(),
    affiliateUrl: text('affiliate_url').notNull(),
    shortUrl: text('short_url'),
    affiliateTag: text('affiliate_tag'),
    verification: affiliateVerificationEnum('verification').notNull(),
    validationStatus: affiliateValidationStatusEnum('validation_status').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('affiliate_links_product_id_idx').on(table.productId)],
);
