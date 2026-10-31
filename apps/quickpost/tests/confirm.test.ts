import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { AMAZON_BUTTON_LABEL } from '../src/format/post.js';
import {
  callbackData,
  CHANNEL,
  createHarness,
  DEAL,
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
      keyboard: [[{ kind: 'url', text: AMAZON_BUTTON_LABEL, url: TAGGED_URL }]],
    });
    expect(preview.text).toContain('Steel Bottle');
    expect(preview.text).toContain('Listed at ₹2,499');
    expect(await harness.log.read()).toEqual([
      {
        asin: 'B0CABCDEFG',
        timestamp: new Date(harness.now()).toISOString(),
        message_id: 2,
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
