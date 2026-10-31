import { pgTable, text } from 'drizzle-orm/pg-core';

/** Process metadata only. Business tables belong in a later task. */
export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
