import { pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

export const productSourceEnum = pgEnum('product_source', [
  'amazon',
  'flipkart',
  'myntra',
  'ajio',
  'other',
]);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: productSourceEnum('source').notNull(),
    externalId: text('external_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    title: text('title'),
    brand: text('brand'),
    category: text('category'),
  },
  (table) => [unique('products_source_external_id_unique').on(table.source, table.externalId)],
);
