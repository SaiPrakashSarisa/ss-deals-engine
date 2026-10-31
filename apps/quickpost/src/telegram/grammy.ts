import { InlineKeyboard } from 'grammy';
import type { Logger } from 'pino';
import { classifyTelegramError } from './classify.js';
import { type Sleep, sendWithSingleRetry } from './retry.js';
import type { Keyboard, SendOutcome, SendRequest, TelegramApi } from './types.js';

export type TelegramSendExtra = {
  parse_mode?: 'HTML';
  reply_markup?: InlineKeyboard;
  link_preview_options?: {
    url?: string;
    prefer_large_media?: boolean;
    show_above_text?: boolean;
  };
};

export interface RawTelegram {
  sendMessage(
    chatId: number | string,
    text: string,
    extra?: TelegramSendExtra,
  ): Promise<{ message_id: number }>;
  answerCallbackQuery(callbackQueryId: string): Promise<unknown>;
}

export function createGrammyApi(api: RawTelegram, sleep: Sleep, logger: Logger): TelegramApi {
  return {
    async sendMessage(request: SendRequest): Promise<SendOutcome> {
      const outcome = await sendWithSingleRetry(() => attemptSend(api, request), sleep);
      if (!outcome.ok) {
        logger.warn({ reason: outcome.reason }, 'telegram send failed');
      }
      return outcome;
    },
    async answerCallback(callbackId: string): Promise<void> {
      try {
        await api.answerCallbackQuery(callbackId);
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Error';
        logger.warn({ name }, 'telegram callback answer failed');
      }
    },
  };
}

async function attemptSend(api: RawTelegram, request: SendRequest): Promise<SendOutcome> {
  try {
    const sent = await api.sendMessage(request.chatId, request.text, sendExtra(request));
    if (typeof sent.message_id !== 'number') {
      return { ok: false, reason: 'uncertain' };
    }
    return { ok: true, messageId: sent.message_id };
  } catch (error) {
    return classifyTelegramError(error);
  }
}

function sendExtra(request: SendRequest): TelegramSendExtra {
  const extra: TelegramSendExtra = {};
  if (request.parseMode !== undefined) {
    extra.parse_mode = request.parseMode;
  }
  if (request.keyboard !== undefined) {
    extra.reply_markup = toInlineKeyboard(request.keyboard);
  }
  if (request.linkPreview !== undefined) {
    extra.link_preview_options = {
      url: request.linkPreview.url,
      prefer_large_media: true,
      show_above_text: true,
    };
  }
  return extra;
}

export function toInlineKeyboard(keyboard: Keyboard): InlineKeyboard {
  const markup = new InlineKeyboard();
  keyboard.forEach((row, index) => {
    if (index > 0) {
      markup.row();
    }
    for (const button of row) {
      if (button.kind === 'url') {
        markup.url(button.text, button.url);
      } else {
        markup.text(button.text, button.data);
      }
    }
  });
  return markup;
}
