import { join } from 'node:path';
import { Bot } from 'grammy';
import { createQuickPost } from './bot/app.js';
import { loadConfig } from './config/env.js';
import { systemClock } from './lib/clock.js';
import { isEntrypoint } from './lib/entrypoint.js';
import { createLogger, startupSummary } from './lib/logger.js';
import { redactToken } from './lib/redact.js';
import { createShutdownHandler, installSignalHandlers } from './lib/shutdown.js';
import { PostedLog } from './store/posted.js';
import { createGrammyApi } from './telegram/grammy.js';
import { defaultSleep } from './telegram/retry.js';

export async function startBot(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info(startupSummary(config), 'quickpost starting');

  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const api = createGrammyApi(
    {
      sendMessage: (chatId, text, extra) => bot.api.sendMessage(chatId, text, extra),
      sendPhoto: (chatId, photo, extra) => bot.api.sendPhoto(chatId, photo, extra),
      answerCallbackQuery: (callbackQueryId) => bot.api.answerCallbackQuery(callbackQueryId),
    },
    defaultSleep,
    logger,
  );
  const app = createQuickPost({
    config,
    api,
    log: new PostedLog(join(config.DATA_DIR, 'posted.json')),
    clock: systemClock,
    logger,
  });

  bot.catch((botError) => {
    const name = botError instanceof Error ? botError.name : 'Error';
    logger.error({ name }, 'quickpost handler failed');
  });

  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      return;
    }
    await app.onMessage({ chatId: ctx.chat.id, userId, text: ctx.message.text });
  });

  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from?.id;
    const fileId = ctx.message.photo.at(-1)?.file_id;
    if (userId === undefined || fileId === undefined || fileId.length === 0) {
      return;
    }
    await app.onMessage({
      chatId: ctx.chat.id,
      userId,
      text: ctx.message.caption ?? '',
      photoFileId: fileId,
    });
  });

  bot.on('callback_query:data', async (ctx) => {
    await app.onCallback({
      chatId: ctx.chat?.id ?? ctx.from.id,
      userId: ctx.from.id,
      callbackId: ctx.callbackQuery.id,
      data: ctx.callbackQuery.data,
    });
  });

  const shutdown = createShutdownHandler({
    stopBot: () => bot.stop(),
    logger,
  });
  installSignalHandlers(shutdown, logger);

  await bot.start({
    onStart: (info) => {
      logger.info({ username: info.username }, 'quickpost polling');
    },
  });
}

if (isEntrypoint(import.meta.url)) {
  startBot().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'quickpost failed to start';
    console.error(redactToken(message, process.env.TELEGRAM_BOT_TOKEN));
    process.exit(1);
  });
}
