import { boolean, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

export const channelPlatformEnum = pgEnum('channel_platform', ['telegram']);

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: channelPlatformEnum('platform').notNull(),
    name: text('name').notNull(),
    username: text('username'),
    chatId: text('chat_id'),
    isActive: boolean('is_active').notNull(),
  },
  (table) => [unique('channels_platform_username_unique').on(table.platform, table.username)],
);
