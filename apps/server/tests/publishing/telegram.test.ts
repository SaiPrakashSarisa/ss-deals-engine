import { describe, expect, it, vi } from 'vitest';
import { createTelegramClient, type TelegramFetch } from '../../src/modules/publishing/telegram.js';

const token = '123456:SECRETTOKEN';

function response(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('telegram client', () => {
  it('sends HTML text and a photo file, and classifies each result', async () => {
    const calls: Array<{ url: string; body: RequestInit['body'] }> = [];
    const fetchImpl: TelegramFetch = vi.fn(async (url, init) => {
      calls.push({ url, body: init.body });
      if (url.endsWith('/sendPhoto')) {
        return response(200, { ok: true, result: { message_id: 7 } });
      }
      return response(200, { ok: true, result: { message_id: 4 } });
    });
    const client = createTelegramClient({ token, timeoutMs: 1000, fetchImpl });
    const text = await client.sendText({
      chatId: '@deals_channel',
      text: '<b>Kettle</b>',
      previewEnabled: false,
    });
    expect(text).toEqual({ kind: 'ok', messageId: 4 });
    const textBody = JSON.parse(String(calls[0]?.body)) as {
      parse_mode: string;
      link_preview_options: { is_disabled: boolean };
    };
    expect(textBody.parse_mode).toBe('HTML');
    expect(textBody.link_preview_options.is_disabled).toBe(true);
    expect(calls[0]?.url).toContain(token);

    const photo = await client.sendPhoto({
      chatId: '@deals_channel',
      caption: '<b>Kettle</b>',
      filename: 'photo.png',
      mime: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      button: { text: 'Open', url: 'https://amzn.to/kettle' },
    });
    expect(photo).toEqual({ kind: 'ok', messageId: 7 });
    expect(calls[1]?.body).toBeInstanceOf(FormData);
    const form = calls[1]?.body as FormData;
    expect(form.get('parse_mode')).toBe('HTML');
    expect(form.get('photo')).toBeInstanceOf(Blob);
  });

  it('classifies rate limits, rejection, server errors, timeouts, and failures before send', async () => {
    const scripted = [
      response(429, { ok: false, error_code: 429, parameters: { retry_after: 8 } }),
      response(400, { ok: false, error_code: 400, description: `bad ${token}` }),
      response(500, { ok: false, description: 'unavailable' }),
      response(200, 'not-json'),
    ];
    let index = 0;
    const client = createTelegramClient({
      token,
      timeoutMs: 1000,
      fetchImpl: async () => {
        const next = scripted[index];
        index += 1;
        if (next === undefined) {
          throw Object.assign(new Error(`connect ${token}`), { code: 'ECONNREFUSED' });
        }
        return next;
      },
    });
    const send = () =>
      client.sendText({ chatId: '@deals_channel', text: 'Hi', previewEnabled: true });
    expect(await send()).toEqual({ kind: 'rate_limited', retryAfterSeconds: 8 });
    const rejected = await send();
    expect(rejected.kind).toBe('rejected');
    if (rejected.kind === 'rejected') {
      expect(rejected.reason).not.toContain(token);
      expect(rejected.reason).toContain('[Redacted]');
    }
    expect((await send()).kind).toBe('uncertain');
    expect((await send()).kind).toBe('uncertain');
    expect(await send()).toMatchObject({ kind: 'not_sent' });

    const timedOut = createTelegramClient({
      token,
      timeoutMs: 1000,
      fetchImpl: async () => {
        throw Object.assign(new Error(`timed out ${token}`), { name: 'AbortError' });
      },
    });
    const timeout = await timedOut.sendText({
      chatId: '@deals_channel',
      text: 'Hi',
      previewEnabled: true,
    });
    expect(timeout.kind).toBe('uncertain');
    if (timeout.kind === 'uncertain') {
      expect(timeout.reason).not.toContain(token);
    }
  });
});
