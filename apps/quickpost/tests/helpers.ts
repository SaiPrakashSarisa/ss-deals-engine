import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { createQuickPost, type QuickPost } from '../src/bot/app.js';
import type { AppConfig } from '../src/config/env.js';
import { PostedLog } from '../src/store/posted.js';
import type {
  PhotoSendRequest,
  SendOutcome,
  SendRequest,
  TelegramApi,
} from '../src/telegram/types.js';

export const OWNER_ID = 424242;
export const OTHER_ID = 7;
export const CHANNEL = '@ss_super_deals';
export const TAG = 'ssdeals-21';
export const TOKEN = '123456789:AATestTokenValue';
export const TAGGED_URL = 'https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21';

export const DEAL = [
  'https://www.amazon.in/Some-Name/dp/B0CABCDEFG?tag=other-21&psc=1#reviews',
  'title: Steel Bottle',
  'price: 1,499',
  'old: 2,499',
  'verified: no',
  '- Leak proof',
].join('\n');

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHANNEL: CHANNEL,
    OWNER_TELEGRAM_ID: OWNER_ID,
    AMAZON_TAG: TAG,
    DAILY_POST_LIMIT: 8,
    DATA_DIR: './data',
    TZ: 'Asia/Kolkata',
    SHORT_LINK_HOSTS: ['amzn.to', 'link.amazon'],
    LINK_STYLE: 'text',
    POST_FOOTER: '',
    ...overrides,
  };
}

export type RecordedMessage = SendRequest & { photo?: string };

export class FakeTelegram implements TelegramApi {
  readonly messages: RecordedMessage[] = [];
  readonly answered: string[] = [];
  channelResults: SendOutcome[] = [];
  channelDelayMs = 0;

  async sendMessage(request: SendRequest): Promise<SendOutcome> {
    return this.record(request);
  }

  async sendPhoto(request: PhotoSendRequest): Promise<SendOutcome> {
    return this.record({
      chatId: request.chatId,
      text: request.caption,
      parseMode: request.parseMode,
      keyboard: request.keyboard,
      photo: request.photo,
    });
  }

  async answerCallback(callbackId: string): Promise<void> {
    this.answered.push(callbackId);
  }

  channelMessages(): RecordedMessage[] {
    return this.messages.filter((message) => message.chatId === CHANNEL);
  }

  private async record(request: RecordedMessage): Promise<SendOutcome> {
    if (request.chatId === CHANNEL && this.channelDelayMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, this.channelDelayMs);
      });
    }
    this.messages.push(request);
    if (request.chatId === CHANNEL) {
      const scripted = this.channelResults.shift();
      if (scripted !== undefined) {
        return scripted;
      }
    }
    return { ok: true, messageId: this.messages.length };
  }
}

export type Harness = {
  api: FakeTelegram;
  log: PostedLog;
  app: QuickPost;
  dir: string;
  now: () => number;
  setNow: (value: number) => void;
  advance: (ms: number) => void;
};

export async function createHarness(options?: {
  now?: number;
  limit?: number;
  linkStyle?: AppConfig['LINK_STYLE'];
  shortLinkHosts?: string[];
  postFooter?: string;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'quickpost-'));
  let now = options?.now ?? Date.parse('2026-10-31T10:00:00.000Z');
  const api = new FakeTelegram();
  const log = new PostedLog(join(dir, 'posted.json'));
  const app = createQuickPost({
    config: testConfig({
      DAILY_POST_LIMIT: options?.limit ?? 8,
      DATA_DIR: dir,
      LINK_STYLE: options?.linkStyle ?? 'text',
      POST_FOOTER: options?.postFooter ?? '',
      ...(options?.shortLinkHosts === undefined
        ? {}
        : { SHORT_LINK_HOSTS: options.shortLinkHosts }),
    }),
    api,
    log,
    clock: () => now,
    logger: pino({ level: 'silent' }),
  });
  return {
    api,
    log,
    app,
    dir,
    now: () => now,
    setNow(value: number) {
      now = value;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

export async function sendDeal(
  harness: Harness,
  text = DEAL,
  photoFileId?: string,
): Promise<RecordedMessage> {
  await harness.app.onMessage({
    chatId: 500,
    userId: OWNER_ID,
    text,
    ...(photoFileId === undefined ? {} : { photoFileId }),
  });
  const preview = [...harness.api.messages]
    .reverse()
    .find((message) => message.parseMode === 'HTML');
  if (preview === undefined) {
    throw new Error('preview was not sent');
  }
  return preview;
}

export function callbackData(message: RecordedMessage, label: string): string {
  for (const row of message.keyboard ?? []) {
    for (const button of row) {
      if (button.kind === 'callback' && button.text === label) {
        return button.data;
      }
    }
  }
  throw new Error(`Missing button ${label}`);
}

export async function tap(harness: Harness, data: string, callbackId = 'cb'): Promise<void> {
  await harness.app.onCallback({
    chatId: 500,
    userId: OWNER_ID,
    callbackId,
    data,
  });
}
