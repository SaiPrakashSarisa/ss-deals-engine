import { GrammyError, HttpError, type InlineKeyboard } from 'grammy';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { classifyTelegramError } from '../src/telegram/classify.js';
import { createGrammyApi, type TelegramSendExtra } from '../src/telegram/grammy.js';
import { sendWithSingleRetry } from '../src/telegram/retry.js';
import type { SendOutcome } from '../src/telegram/types.js';

const logger = pino({ level: 'silent' });

describe('sendWithSingleRetry', () => {
  it('retries a 429 once after retry_after', async () => {
    const sleeps: number[] = [];
    const outcomes: SendOutcome[] = [
      { ok: false, reason: 'rate_limited', retryAfterSeconds: 2 },
      { ok: true, messageId: 7 },
    ];
    const result = await sendWithSingleRetry(
      async () => {
        const next = outcomes.shift();
        if (next === undefined) {
          throw new Error('too many attempts');
        }
        return next;
      },
      async (ms) => {
        sleeps.push(ms);
      },
    );

    expect(result).toEqual({ ok: true, messageId: 7 });
    expect(sleeps).toEqual([2000]);
    expect(outcomes).toEqual([]);
  });

  it('does not retry an uncertain result', async () => {
    let calls = 0;
    const result = await sendWithSingleRetry(
      async () => {
        calls += 1;
        return { ok: false, reason: 'uncertain' };
      },
      async () => {
        throw new Error('should not sleep');
      },
    );

    expect(result).toEqual({ ok: false, reason: 'uncertain' });
    expect(calls).toBe(1);
  });
});

describe('telegram adapter', () => {
  it('sends link preview options and retries one 429', async () => {
    const calls: TelegramSendExtra[] = [];
    const sleeps: number[] = [];
    let failures = 1;
    const api = createGrammyApi(
      {
        async sendMessage(_chatId, _text, extra) {
          calls.push(extra ?? {});
          if (failures > 0) {
            failures -= 1;
            throw new GrammyError(
              'Too Many Requests',
              {
                ok: false,
                error_code: 429,
                description: 'Too Many Requests',
                parameters: { retry_after: 2 },
              },
              'sendMessage',
              {},
            );
          }
          return { message_id: 15 };
        },
        async answerCallbackQuery() {
          return true;
        },
      },
      async (ms) => {
        sleeps.push(ms);
      },
      logger,
    );

    const outcome = await api.sendMessage({
      chatId: '@ss_super_deals',
      text: '<b>Deal</b>',
      parseMode: 'HTML',
      keyboard: [
        [
          {
            kind: 'url',
            text: '🛒 Check deal on Amazon',
            url: 'https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21',
          },
        ],
      ],
      linkPreview: { url: 'https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21' },
    });

    expect(outcome).toEqual({ ok: true, messageId: 15 });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect(calls[0]?.link_preview_options).toEqual({
      url: 'https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21',
      prefer_large_media: true,
      show_above_text: true,
    });
    expect(calls[0]?.parse_mode).toBe('HTML');
    const markup = calls[0]?.reply_markup as InlineKeyboard | undefined;
    expect(markup?.inline_keyboard).toEqual([
      [
        {
          text: '🛒 Check deal on Amazon',
          url: 'https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21',
        },
      ],
    ]);
  });

  it('does not retry a timeout', async () => {
    let calls = 0;
    const api = createGrammyApi(
      {
        async sendMessage() {
          calls += 1;
          throw new HttpError('timeout', new Error('The operation was aborted'));
        },
        async answerCallbackQuery() {
          return true;
        },
      },
      async () => {
        throw new Error('should not sleep');
      },
      logger,
    );

    const outcome = await api.sendMessage({ chatId: 1, text: 'hello' });
    expect(outcome).toEqual({ ok: false, reason: 'uncertain' });
    expect(calls).toBe(1);
  });

  it('classifies server errors as uncertain and client errors as rejected', () => {
    expect(
      classifyTelegramError(
        new GrammyError(
          'Internal',
          { ok: false, error_code: 500, description: 'Internal Server Error', parameters: {} },
          'sendMessage',
          {},
        ),
      ),
    ).toEqual({ ok: false, reason: 'uncertain' });
    expect(
      classifyTelegramError(
        new GrammyError(
          'Bad Request',
          {
            ok: false,
            error_code: 400,
            description: "Bad Request: can't parse entities",
            parameters: {},
          },
          'sendMessage',
          {},
        ),
      ),
    ).toEqual({ ok: false, reason: 'rejected', description: "Bad Request: can't parse entities" });
  });
});
