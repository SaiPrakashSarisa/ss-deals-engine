import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import { AMAZON_BUTTON_LABEL, formatPost } from '../format/post.js';
import type { Clock } from '../lib/clock.js';
import { redactToken } from '../lib/redact.js';
import { parseDealMessage } from '../parse/message.js';
import { DUPLICATE_WINDOW_MS, countPostsOnDay, findRecentDuplicate } from '../store/policy.js';
import type { PostedEntry, PostedLog } from '../store/posted.js';
import type { Keyboard, TelegramApi } from '../telegram/types.js';
import { helpText } from './help.js';

const PREVIEW_TTL_MS = 30 * 60 * 1000;

type Stage = 'ready' | 'need_duplicate' | 'need_override' | 'posting' | 'posted' | 'cancelled';
type ConfirmAction = 'post' | 'dup' | 'over';
type CallbackAction = ConfirmAction | 'cancel';

type Preview = {
  id: string;
  chatId: number;
  userId: number;
  html: string;
  taggedUrl: string;
  asin: string;
  createdAtMs: number;
  stage: Stage;
  busy: boolean;
};

export type IncomingMessage = {
  chatId: number;
  userId: number;
  text: string;
};

export type IncomingCallback = {
  chatId: number;
  userId: number;
  callbackId: string;
  data: string;
};

type Transition =
  | { type: 'ignore' }
  | { type: 'missing' }
  | { type: 'expired' }
  | { type: 'cancelled' }
  | { type: 'proceed'; action: ConfirmAction; preview: Preview };

export type QuickPost = {
  onMessage(update: IncomingMessage): Promise<void>;
  onCallback(update: IncomingCallback): Promise<void>;
};

export function createQuickPost(deps: {
  config: AppConfig;
  api: TelegramApi;
  log: PostedLog;
  clock: Clock;
  logger: Logger;
}): QuickPost {
  const previews = new Map<string, Preview>();

  return {
    onMessage(update) {
      return handleMessage(deps, previews, update);
    },
    onCallback(update) {
      return handleCallback(deps, previews, update);
    },
  };
}

async function handleMessage(
  deps: {
    config: AppConfig;
    api: TelegramApi;
    clock: Clock;
    logger: Logger;
  },
  previews: Map<string, Preview>,
  update: IncomingMessage,
): Promise<void> {
  if (isExactCommand(update.text, 'whoami')) {
    await deps.api.sendMessage({ chatId: update.chatId, text: String(update.userId) });
    return;
  }
  if (update.userId !== deps.config.OWNER_TELEGRAM_ID) {
    deps.logger.debug({ userId: update.userId }, 'ignored non-owner message');
    return;
  }
  if (isExactCommand(update.text, 'start') || isExactCommand(update.text, 'help')) {
    await deps.api.sendMessage({
      chatId: update.chatId,
      text: helpText(deps.config.DAILY_POST_LIMIT),
    });
    return;
  }
  await createPreview(deps, previews, update);
}

async function createPreview(
  deps: {
    config: AppConfig;
    api: TelegramApi;
    clock: Clock;
    logger: Logger;
  },
  previews: Map<string, Preview>,
  update: IncomingMessage,
): Promise<void> {
  const parsed = parseDealMessage(update.text, deps.config.AMAZON_TAG);
  if (!parsed.ok) {
    await reply(deps.api, update.chatId, parsed.errors.map((error) => `• ${error}`).join('\n'));
    return;
  }

  const formatted = formatPost({
    title: parsed.draft.title,
    price: parsed.draft.price,
    oldPrice: parsed.draft.oldPrice,
    verified: parsed.draft.verified,
    highlights: parsed.draft.highlights,
    taggedUrl: parsed.draft.taggedUrl,
  });
  if (!formatted.ok) {
    await reply(deps.api, update.chatId, formatted.message);
    return;
  }

  const id = randomBytes(8).toString('hex');
  previews.set(id, {
    id,
    chatId: update.chatId,
    userId: update.userId,
    html: formatted.html,
    taggedUrl: parsed.draft.taggedUrl,
    asin: parsed.draft.asin,
    createdAtMs: deps.clock(),
    stage: 'ready',
    busy: false,
  });

  if (formatted.warnings.length > 0) {
    await reply(deps.api, update.chatId, `Warning: ${formatted.warnings.join(' ')}`);
  }

  await deps.api.sendMessage({
    chatId: update.chatId,
    text: formatted.html,
    parseMode: 'HTML',
    keyboard: previewKeyboard(id, parsed.draft.taggedUrl),
  });
  deps.logger.info({ asin: parsed.draft.asin, previewId: id }, 'preview ready');
}

async function handleCallback(
  deps: {
    config: AppConfig;
    api: TelegramApi;
    log: PostedLog;
    clock: Clock;
    logger: Logger;
  },
  previews: Map<string, Preview>,
  update: IncomingCallback,
): Promise<void> {
  if (update.userId !== deps.config.OWNER_TELEGRAM_ID) {
    deps.logger.debug({ userId: update.userId }, 'ignored non-owner callback');
    return;
  }

  const transition = takeTransition(deps, previews, update);
  await deps.api.answerCallback(update.callbackId);

  if (transition.type === 'ignore') {
    return;
  }
  if (transition.type === 'missing') {
    await reply(deps.api, update.chatId, 'That preview is no longer available.');
    return;
  }
  if (transition.type === 'expired') {
    await reply(
      deps.api,
      update.chatId,
      'This preview expired after 30 minutes. Send the deal again.',
    );
    return;
  }
  if (transition.type === 'cancelled') {
    await reply(deps.api, update.chatId, 'Cancelled. Nothing was posted.');
    return;
  }

  await publish(deps, update, transition.preview, transition.action);
}

function takeTransition(
  deps: { clock: Clock },
  previews: Map<string, Preview>,
  update: IncomingCallback,
): Transition {
  const parsed = parseCallbackData(update.data);
  if (parsed === undefined) {
    return { type: 'ignore' };
  }
  const preview = previews.get(parsed.id);
  if (preview === undefined || preview.userId !== update.userId) {
    return { type: 'missing' };
  }
  if (
    preview.busy ||
    preview.stage === 'posting' ||
    preview.stage === 'posted' ||
    preview.stage === 'cancelled'
  ) {
    return { type: 'ignore' };
  }
  if (deps.clock() - preview.createdAtMs >= PREVIEW_TTL_MS) {
    preview.stage = 'cancelled';
    return { type: 'expired' };
  }
  if (parsed.action === 'cancel') {
    preview.stage = 'cancelled';
    return { type: 'cancelled' };
  }
  if (preview.stage !== expectedStage(parsed.action)) {
    return { type: 'ignore' };
  }
  preview.busy = true;
  return { type: 'proceed', action: parsed.action, preview };
}

async function publish(
  deps: {
    config: AppConfig;
    api: TelegramApi;
    log: PostedLog;
    clock: Clock;
    logger: Logger;
  },
  update: IncomingCallback,
  preview: Preview,
  action: ConfirmAction,
): Promise<void> {
  const resumeStage = expectedStage(action);
  let entries: PostedEntry[];
  try {
    entries = await deps.log.read();
  } catch (error) {
    preview.busy = false;
    deps.logger.error(
      { name: error instanceof Error ? error.name : 'Error' },
      'posted log unreadable',
    );
    await reply(deps.api, update.chatId, 'I could not read the posted log, so I did not post.');
    return;
  }

  if (action === 'post') {
    const recent = findRecentDuplicate(entries, preview.asin, deps.clock(), DUPLICATE_WINDOW_MS);
    if (recent !== undefined) {
      preview.stage = 'need_duplicate';
      preview.busy = false;
      await deps.api.sendMessage({
        chatId: update.chatId,
        text: `This ASIN was posted in the last 14 days (${recent.timestamp}). Tap Post anyway to publish it again.`,
        keyboard: confirmKeyboard(preview.id, 'dup', 'Post anyway'),
      });
      return;
    }
  }

  if (action === 'post' || action === 'dup') {
    const postedToday = countPostsOnDay(entries, deps.clock(), deps.config.TZ);
    if (postedToday >= deps.config.DAILY_POST_LIMIT) {
      preview.stage = 'need_override';
      preview.busy = false;
      await deps.api.sendMessage({
        chatId: update.chatId,
        text: `The daily limit of ${deps.config.DAILY_POST_LIMIT} posts is reached. Tap Override daily limit to post anyway.`,
        keyboard: confirmKeyboard(preview.id, 'over', 'Override daily limit'),
      });
      return;
    }
  }

  preview.stage = 'posting';
  const outcome = await deps.api.sendMessage({
    chatId: deps.config.TELEGRAM_CHANNEL,
    text: preview.html,
    parseMode: 'HTML',
    keyboard: [[{ kind: 'url', text: AMAZON_BUTTON_LABEL, url: preview.taggedUrl }]],
    linkPreview: { url: preview.taggedUrl },
  });

  if (outcome.ok) {
    await record(deps, update.chatId, preview, outcome.messageId, 'Posted to the channel.');
    return;
  }
  if (outcome.reason === 'uncertain') {
    await record(
      deps,
      update.chatId,
      preview,
      'uncertain',
      'Telegram did not confirm whether the post went out. Check the channel before sending it again. I marked this ASIN as uncertain.',
    );
    return;
  }

  preview.stage = resumeStage;
  preview.busy = false;
  if (outcome.reason === 'rate_limited') {
    await reply(
      deps.api,
      update.chatId,
      `Telegram is rate limiting the bot (retry after ${outcome.retryAfterSeconds}s). I did not post. Try again later.`,
    );
    return;
  }

  const description = redactToken(outcome.description, deps.config.TELEGRAM_BOT_TOKEN);
  await reply(
    deps.api,
    update.chatId,
    `Telegram rejected the post. I did not publish it. ${description}`,
  );
}

async function record(
  deps: {
    api: TelegramApi;
    log: PostedLog;
    clock: Clock;
    logger: Logger;
  },
  chatId: number,
  preview: Preview,
  messageId: number | 'uncertain',
  ownerText: string,
): Promise<void> {
  preview.stage = 'posted';
  try {
    await deps.log.append({
      asin: preview.asin,
      timestamp: new Date(deps.clock()).toISOString(),
      message_id: messageId,
    });
  } catch (error) {
    deps.logger.error(
      { name: error instanceof Error ? error.name : 'Error', asin: preview.asin },
      'posted log write failed',
    );
    await reply(deps.api, chatId, `${ownerText} I could not update the local post log.`);
    return;
  }

  deps.logger.info({ asin: preview.asin, messageId }, 'channel post recorded');
  await reply(deps.api, chatId, ownerText);
}

function previewKeyboard(id: string, taggedUrl: string): Keyboard {
  return [
    [{ kind: 'url', text: AMAZON_BUTTON_LABEL, url: taggedUrl }],
    [
      { kind: 'callback', text: 'Post to channel', data: `post:${id}` },
      { kind: 'callback', text: 'Cancel', data: `cancel:${id}` },
    ],
  ];
}

function confirmKeyboard(id: string, action: 'dup' | 'over', label: string): Keyboard {
  return [
    [
      { kind: 'callback', text: label, data: `${action}:${id}` },
      { kind: 'callback', text: 'Cancel', data: `cancel:${id}` },
    ],
  ];
}

function expectedStage(action: ConfirmAction): Stage {
  if (action === 'post') {
    return 'ready';
  }
  if (action === 'dup') {
    return 'need_duplicate';
  }
  return 'need_override';
}

function parseCallbackData(data: string): { action: CallbackAction; id: string } | undefined {
  const match = /^(post|cancel|dup|over):([0-9a-f]{16})$/.exec(data);
  const action = match?.[1];
  const id = match?.[2];
  if (
    id === undefined ||
    (action !== 'post' && action !== 'cancel' && action !== 'dup' && action !== 'over')
  ) {
    return undefined;
  }
  return { action, id };
}

function isExactCommand(text: string, name: string): boolean {
  return new RegExp(`^/${name}(?:@[A-Za-z0-9_]+)?\\s*$`, 'i').test(text.trim());
}

async function reply(api: TelegramApi, chatId: number, text: string): Promise<void> {
  await api.sendMessage({ chatId, text });
}
