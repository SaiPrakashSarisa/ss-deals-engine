import { pgTable, text } from 'drizzle-orm/pg-core';

/** Process metadata. Business tables live in the other schema modules. */
export const appMeta = pgTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
