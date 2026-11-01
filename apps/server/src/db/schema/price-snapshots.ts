import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { deals } from './deals.js';
import { products } from './products.js';
import { users } from './users.js';

export const priceSnapshotOriginEnum = pgEnum('price_snapshot_origin', [
  'clerk_entered',
  'owner_entered',
  'api',
  'quickpost_import',
]);

export const priceSnapshots = pgTable(
  'price_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id),
    dealId: uuid('deal_id').references(() => deals.id),
    pricePaise: integer('price_paise').notNull(),
    origin: priceSnapshotOriginEnum('origin').notNull(),
    recordedBy: uuid('recorded_by').references(() => users.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('price_snapshots_price_paise_positive', sql`${table.pricePaise} > 0`),
    index('price_snapshots_product_recorded_at_idx').on(table.productId, table.recordedAt.desc()),
  ],
);
