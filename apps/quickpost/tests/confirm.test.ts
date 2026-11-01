import http from 'node:http';
import https from 'node:https';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AMAZON_BUTTON_LABEL } from '@ss-deals/core';
import { shortLinkError } from '../src/parse/message.js';
import {
  callbackData,
  CHANNEL,
  createHarness,
  DEAL,
  OTHER_ID,
  OWNER_ID,
  sendDeal,
  TAGGED_URL,
  tap,
  type Harness,
} from './helpers.js';

const PREVIEW_TTL_MS = 30 * 60 * 1000;

describe('confirm flow', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await rm(harness.dir, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it('posts once on confirm and keeps the preview text', async () => {
    harness = await createHarness();
    const preview = await sendDeal(harness);
    expect(harness.api.channelMessages()).toHaveLength(0);

    await tap(harness, callbackData(preview, 'Post to channel'));

    const posted = harness.api.channelMessages();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      chatId: CHANNEL,
      text: preview.text,
      parseMode: 'HTML',
      linkPreview: { url: TAGGED_URL },
    });
    expect(posted[0]?.keyboard).toBeUndefined();
    expect(preview.text).toContain('🔥 <b>Steel Bottle</b>');
    expect(preview.text).toContain('🎁 <b>Deal Price : ₹1,499</b>');
    expect(preview.text).toContain('Listed at ₹2,499');
    expect(preview.text).toContain(`🛒 Buy Here : ${TAGGED_URL}`);
    expect(preview.text.toLowerCase()).not.toContain('blockquote');
    expect(preview.text).not.toContain('<i>');
    expect(await harness.log.read()).toEqual([
      {
        asin: 'B0CABCDEFG',
        timestamp: new Date(harness.now()).toISOString(),
        message_id: 2,
        mode: 'text',
        link: 'tagged',
      },
    ]);
  });

  it('does not post when the owner cancels', async () => {
    harness = await createHarness();
    const preview = await sendDeal(harness);
    await tap(harness, callbackData(preview, 'Cancel'));
    await tap(harness, callbackData(preview, 'Post to channel'), 'again');

    expect(harness.api.channelMessages()).toHaveLength(0);
    expect(harness.api.messages.some((message) => message.text.includes('Cancelled'))).toBe(true);
    expect(await harness.log.read()).toEqual([]);
  });

  it('refuses an expired preview and still posts one that is just inside the window', async () => {
    harness = await createHarness();
    const fresh = await sendDeal(harness);
    harness.advance(PREVIEW_TTL_MS - 1);
    await tap(harness, callbackData(fresh, 'Post to channel'));
    expect(harness.api.channelMessages()).toHaveLength(1);

    const stale = await sendDeal(harness);
    harness.advance(PREVIEW_TTL_MS);
    await tap(harness, callbackData(stale, 'Post to channel'), 'stale');
    expect(harness.api.channelMessages()).toHaveLength(1);
    expect(harness.api.messages.some((message) => message.text.includes('expired'))).toBe(true);
  });

  it('does not post twice when confirm is tapped twice', async () => {
    harness = await createHarness();
    const preview = await sendDeal(harness);
    const data = callbackData(preview, 'Post to channel');
    harness.api.channelDelayMs = 30;

    await Promise.all([tap(harness, data, 'a'), tap(harness, data, 'b')]);

    expect(harness.api.channelMessages()).toHaveLength(1);
    expect(await harness.log.read()).toHaveLength(1);
  });

  it('requires a second confirmation for a recent duplicate', async () => {
    harness = await createHarness();
    await harness.log.append({
      asin: 'B0CABCDEFG',
      timestamp: new Date(harness.now() - 24 * 60 * 60 * 1000).toISOString(),
      message_id: 4,
    });
    const preview = await sendDeal(harness);
    await tap(harness, callbackData(preview, 'Post to channel'));

    expect(harness.api.channelMessages()).toHaveLength(0);
    const warning = harness.api.messages.at(-1);
    expect(warning?.text).toContain('last 14 days');
    if (warning === undefined) {
      return;
    }
    await tap(harness, callbackData(warning, 'Post anyway'), 'dup');

    expect(harness.api.channelMessages()).toHaveLength(1);
    expect(await harness.log.read()).toHaveLength(2);
  });

  it('asks for an override when the daily limit is reached', async () => {
    harness = await createHarness({ limit: 1 });
    await harness.log.append({
      asin: 'B0TEST0001',
      timestamp: new Date(harness.now()).toISOString(),
      message_id: 3,
    });
    const preview = await sendDeal(harness);
    await tap(harness, callbackData(preview, 'Post to channel'));

    expect(harness.api.channelMessages()).toHaveLength(0);
    const warning = harness.api.messages.at(-1);
    expect(warning?.text).toContain('daily limit of 1');
    if (warning === undefined) {
      return;
    }
    await tap(harness, callbackData(warning, 'Override daily limit'), 'over');

    expect(harness.api.channelMessages()).toHaveLength(1);
  });

  it('marks an uncertain send and does not retry it', async () => {
    harness = await createHarness();
    harness.api.channelResults.push({ ok: false, reason: 'uncertain' });
    const preview = await sendDeal(harness);
    const data = callbackData(preview, 'Post to channel');
    await tap(harness, data);
    await tap(harness, data, 'again');

    expect(harness.api.channelMessages()).toHaveLength(1);
    expect(await harness.log.read()).toEqual([
      {
        asin: 'B0CABCDEFG',
        timestamp: new Date(harness.now()).toISOString(),
        message_id: 'uncertain',
        mode: 'text',
        link: 'tagged',
      },
    ]);
    expect(harness.api.messages.some((message) => message.text.includes('Check the channel'))).toBe(
      true,
    );
  });

  it('does not record a post when Telegram keeps rate limiting', async () => {
    harness = await createHarness();
    harness.api.channelResults.push({ ok: false, reason: 'rate_limited', retryAfterSeconds: 3 });
    const preview = await sendDeal(harness);
    const data = callbackData(preview, 'Post to channel');
    await tap(harness, data);

    expect(await harness.log.read()).toEqual([]);
    expect(harness.api.messages.some((message) => message.text.includes('rate limiting'))).toBe(
      true,
    );

    await tap(harness, data, 'retry');
    expect(harness.api.channelMessages()).toHaveLength(2);
    expect(await harness.log.read()).toHaveLength(1);
  });

  it('warns the owner about forbidden words and does not post them as the warning', async () => {
    harness = await createHarness();
    const preview = await sendDeal(
      harness,
      ['https://www.amazon.in/dp/B0CABCDEFG', 'title: Hurry bottle', 'price: 999'].join('\n'),
    );
    expect(harness.api.messages.some((message) => message.text.includes('hurry'))).toBe(true);
    expect(preview.text).not.toContain('Warning');
    await tap(harness, callbackData(preview, 'Post to channel'));
    expect(harness.api.channelMessages()[0]?.text).toBe(preview.text);
  });

  it('does not post an invalid deal', async () => {
    harness = await createHarness();
    await harness.app.onMessage({ chatId: 500, userId: OWNER_ID, text: 'hello' });
    expect(harness.api.channelMessages()).toHaveLength(0);
    expect(harness.api.messages.at(-1)?.text).toContain('Paste the full amazon.in product link.');
    expect(harness.api.messages.at(-1)?.text).toContain('Add a title: line.');
    expect(DEAL).toContain('amazon.in');
  });
});

const SHORT_URL = 'https://amzn.to/bottleDeal';
const SHORT_WARNING =
  'Short link not verified by the bot - make sure it came from your Associates account.';
const PHOTO_FILE_ID = 'AgACAgQAAxkBTEST';

function dealWith(extra: string): string {
  return `${DEAL}\n${extra}`;
}

describe('link style and preview', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await rm(harness.dir, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it.each(['button', 'both'] as const)('posts a %s link with the shown URL', async (style) => {
    harness = await createHarness({ linkStyle: style });
    const preview = await sendDeal(harness, dealWith(`short: ${SHORT_URL}`));
    await tap(harness, callbackData(preview, 'Post to channel'));

    const posted = harness.api.channelMessages()[0];
    const button = [[{ kind: 'url' as const, text: AMAZON_BUTTON_LABEL, url: SHORT_URL }]];
    expect(posted?.keyboard).toEqual(button);
    expect(posted?.linkPreview).toEqual({ url: SHORT_URL });
    expect(preview.keyboard?.[0]).toEqual(button[0]);
    if (style === 'button') {
      expect(posted?.text).not.toContain('Buy Here');
    } else {
      expect(posted?.text).toContain(`🛒 Buy Here : ${SHORT_URL}`);
    }
    expect(posted?.text).not.toContain('tag=ssdeals-21');
    expect(posted?.text).not.toContain(SHORT_WARNING);
    expect(preview.text).toContain(SHORT_WARNING);
  });

  it('disables the link preview when preview is off', async () => {
    harness = await createHarness();
    const preview = await sendDeal(harness, dealWith('preview: off'));
    await tap(harness, callbackData(preview, 'Post to channel'));

    expect(preview.linkPreview).toEqual({ disabled: true });
    expect(harness.api.channelMessages()[0]?.linkPreview).toEqual({ disabled: true });
    expect(preview.text).toContain(`🛒 Buy Here : ${TAGGED_URL}`);
  });

  it('shows an allowed short link without requesting it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const httpSpy = vi.spyOn(http, 'request').mockImplementation(() => {
      throw new Error('network');
    });
    const httpsSpy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('network');
    });
    harness = await createHarness();

    try {
      const preview = await sendDeal(harness, dealWith(`short: ${SHORT_URL}`));
      await tap(harness, callbackData(preview, 'Post to channel'));

      const posted = harness.api.channelMessages()[0];
      expect(posted?.text).toContain(`🛒 Buy Here : ${SHORT_URL}`);
      expect(posted?.text).not.toContain(SHORT_WARNING);
      expect(posted?.text).not.toContain('tag=');
      expect(preview.text.endsWith(SHORT_WARNING)).toBe(true);
      expect(await harness.log.read()).toMatchObject([{ mode: 'text', link: 'short' }]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
    }
  });

  it('posts the configured footer in italics and adds nothing when it is empty', async () => {
    harness = await createHarness({ postFooter: 'A & B <C>' });
    const preview = await sendDeal(harness);
    await tap(harness, callbackData(preview, 'Post to channel'));

    const posted = harness.api.channelMessages()[0];
    expect(preview.text.endsWith('\n\n<i>A &amp; B &lt;C&gt;</i>')).toBe(true);
    expect(preview.text.toLowerCase()).not.toContain('blockquote');
    expect(posted?.text).toBe(preview.text);
  });

  it('rejects a short link on another host and does not post', async () => {
    harness = await createHarness();
    await harness.app.onMessage({
      chatId: 500,
      userId: OWNER_ID,
      text: dealWith('short: https://evil.example/deal'),
    });

    expect(harness.api.channelMessages()).toHaveLength(0);
    expect(harness.api.messages.some((message) => message.parseMode === 'HTML')).toBe(false);
    expect(harness.api.messages.at(-1)?.text).toContain(shortLinkError(['amzn.to', 'link.amazon']));
  });
});

describe('photo posts', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await rm(harness.dir, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it('previews and posts the same file id with the formatted caption', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const httpsSpy = vi.spyOn(https, 'get').mockImplementation(() => {
      throw new Error('network');
    });
    harness = await createHarness();

    try {
      const preview = await sendDeal(harness, DEAL, PHOTO_FILE_ID);
      expect(preview.photo).toBe(PHOTO_FILE_ID);
      expect(preview.text).toContain('🔥 <b>Steel Bottle</b>');
      expect(preview.text.toLowerCase()).not.toContain('blockquote');
      expect(preview.linkPreview).toBeUndefined();
      expect(preview.keyboard?.at(-1)?.map((button) => button.text)).toEqual([
        'Post to channel',
        'Cancel',
      ]);

      await tap(harness, callbackData(preview, 'Post to channel'));

      const posted = harness.api.channelMessages();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject({
        chatId: CHANNEL,
        photo: PHOTO_FILE_ID,
        text: preview.text,
        parseMode: 'HTML',
      });
      expect(posted[0]?.photo?.startsWith('http')).toBe(false);
      expect(posted[0]?.linkPreview).toBeUndefined();
      expect(await harness.log.read()).toEqual([
        {
          asin: 'B0CABCDEFG',
          timestamp: new Date(harness.now()).toISOString(),
          message_id: 2,
          mode: 'photo',
          link: 'tagged',
        },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      httpsSpy.mockRestore();
    }
  });

  it('posts a photo once when confirm is tapped twice', async () => {
    harness = await createHarness();
    const preview = await sendDeal(harness, DEAL, PHOTO_FILE_ID);
    const data = callbackData(preview, 'Post to channel');
    harness.api.channelDelayMs = 30;

    await Promise.all([tap(harness, data, 'a'), tap(harness, data, 'b')]);

    expect(harness.api.channelMessages()).toHaveLength(1);
    expect(harness.api.channelMessages()[0]?.photo).toBe(PHOTO_FILE_ID);
    expect(await harness.log.read()).toHaveLength(1);
  });

  it('refuses an expired photo preview', async () => {
    harness = await createHarness();
    const preview = await sendDeal(harness, DEAL, PHOTO_FILE_ID);
    harness.advance(PREVIEW_TTL_MS);
    await tap(harness, callbackData(preview, 'Post to channel'));

    expect(harness.api.channelMessages()).toHaveLength(0);
    expect(harness.api.messages.some((message) => message.text.includes('expired'))).toBe(true);
  });

  it('requires a second confirmation for a recent duplicate photo', async () => {
    harness = await createHarness();
    await harness.log.append({
      asin: 'B0CABCDEFG',
      timestamp: new Date(harness.now() - 24 * 60 * 60 * 1000).toISOString(),
      message_id: 4,
    });
    const preview = await sendDeal(harness, DEAL, PHOTO_FILE_ID);
    await tap(harness, callbackData(preview, 'Post to channel'));

    expect(harness.api.channelMessages()).toHaveLength(0);
    const warning = harness.api.messages.at(-1);
    expect(warning?.text).toContain('last 14 days');
    if (warning === undefined) {
      return;
    }
    await tap(harness, callbackData(warning, 'Post anyway'), 'dup');

    expect(harness.api.channelMessages()).toEqual([
      expect.objectContaining({ photo: PHOTO_FILE_ID }),
    ]);
    expect(await harness.log.read()).toHaveLength(2);
    expect((await harness.log.read()).at(-1)).toMatchObject({ mode: 'photo', link: 'tagged' });
  });

  it('asks for an override when a photo would pass the daily limit', async () => {
    harness = await createHarness({ limit: 1 });
    await harness.log.append({
      asin: 'B0TEST0001',
      timestamp: new Date(harness.now()).toISOString(),
      message_id: 3,
    });
    const preview = await sendDeal(harness, DEAL, PHOTO_FILE_ID);
    await tap(harness, callbackData(preview, 'Post to channel'));

    expect(harness.api.channelMessages()).toHaveLength(0);
    const warning = harness.api.messages.at(-1);
    expect(warning?.text).toContain('daily limit of 1');
    if (warning === undefined) {
      return;
    }
    await tap(harness, callbackData(warning, 'Override daily limit'), 'over');

    expect(harness.api.channelMessages()).toHaveLength(1);
    expect(harness.api.channelMessages()[0]?.photo).toBe(PHOTO_FILE_ID);
  });

  it('marks an uncertain photo send and does not retry it', async () => {
    harness = await createHarness();
    harness.api.channelResults.push({ ok: false, reason: 'uncertain' });
    const preview = await sendDeal(harness, DEAL, PHOTO_FILE_ID);
    const data = callbackData(preview, 'Post to channel');
    await tap(harness, data);
    await tap(harness, data, 'again');

    expect(harness.api.channelMessages()).toHaveLength(1);
    expect(await harness.log.read()).toMatchObject([
      { message_id: 'uncertain', mode: 'photo', link: 'tagged' },
    ]);
  });

  it('does not send a photo when the caption is missing', async () => {
    harness = await createHarness();
    await harness.app.onMessage({
      chatId: 500,
      userId: OWNER_ID,
      text: '',
      photoFileId: PHOTO_FILE_ID,
    });

    expect(harness.api.messages.some((message) => message.photo !== undefined)).toBe(false);
    expect(harness.api.channelMessages()).toHaveLength(0);
    expect(harness.api.messages.at(-1)?.text).toContain('Paste the full amazon.in product link.');
    expect(harness.api.messages.at(-1)?.text).toContain('Add a title: line.');
  });

  it('refuses a photo whose formatted caption is not under 900, including a source caption over 1024', async () => {
    harness = await createHarness();
    await harness.app.onMessage({
      chatId: 500,
      userId: OWNER_ID,
      text: [
        'https://www.amazon.in/dp/B0CABCDEFG',
        `title: ${'B'.repeat(1024)}`,
        'price: 1499',
      ].join('\n'),
      photoFileId: PHOTO_FILE_ID,
    });

    expect(harness.api.messages.some((message) => message.photo !== undefined)).toBe(false);
    expect(harness.api.messages.at(-1)?.text).toContain('under 900');
    expect(harness.api.channelMessages()).toHaveLength(0);
  });

  it('records a short link on a photo and keeps the file id', async () => {
    harness = await createHarness();
    const preview = await sendDeal(harness, dealWith(`short: ${SHORT_URL}`), PHOTO_FILE_ID);
    expect(preview.photo).toBe(PHOTO_FILE_ID);
    expect(preview.text).toContain(SHORT_WARNING);
    await tap(harness, callbackData(preview, 'Post to channel'));

    const posted = harness.api.channelMessages()[0];
    expect(posted?.photo).toBe(PHOTO_FILE_ID);
    expect(posted?.text).toContain(`🛒 Buy Here : ${SHORT_URL}`);
    expect(posted?.text).not.toContain(SHORT_WARNING);
    expect(await harness.log.read()).toMatchObject([{ mode: 'photo', link: 'short' }]);
  });

  it('ignores a photo from someone who is not the owner', async () => {
    harness = await createHarness();
    await harness.app.onMessage({
      chatId: 2,
      userId: OTHER_ID,
      text: DEAL,
      photoFileId: PHOTO_FILE_ID,
    });

    expect(harness.api.messages).toHaveLength(0);
    expect(harness.api.channelMessages()).toHaveLength(0);
  });
});
