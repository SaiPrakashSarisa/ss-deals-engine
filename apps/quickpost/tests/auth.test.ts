import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  callbackData,
  CHANNEL,
  createHarness,
  OTHER_ID,
  OWNER_ID,
  sendDeal,
  type Harness,
} from './helpers.js';

describe('authorization', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    if (harness !== undefined) {
      await rm(harness.dir, { recursive: true, force: true });
      harness = undefined;
    }
  });

  it('gives non-owners no reply except /whoami', async () => {
    harness = await createHarness();
    await harness.app.onMessage({ chatId: 2, userId: OTHER_ID, text: '/start' });
    await harness.app.onMessage({ chatId: 2, userId: OTHER_ID, text: '/help' });
    await harness.app.onMessage({
      chatId: 2,
      userId: OTHER_ID,
      text: 'https://www.amazon.in/dp/B0CABCDEFG\ntitle: Bottle\nprice: 1499',
    });
    expect(harness.api.messages).toHaveLength(0);

    await harness.app.onMessage({ chatId: 2, userId: OTHER_ID, text: '/whoami' });
    await harness.app.onMessage({ chatId: 2, userId: OTHER_ID, text: '/whoami@QuickPostBot' });
    await harness.app.onMessage({ chatId: 2, userId: OTHER_ID, text: 'hello' });

    expect(harness.api.messages.map((message) => message.text)).toEqual(['7', '7']);
    expect(harness.api.messages.every((message) => message.chatId === 2)).toBe(true);
    expect(harness.api.channelMessages()).toHaveLength(0);
  });

  it('shows the owner the input format and does not post it', async () => {
    harness = await createHarness();
    await harness.app.onMessage({ chatId: 500, userId: OWNER_ID, text: '/start' });
    await harness.app.onMessage({ chatId: 500, userId: OWNER_ID, text: '/help' });

    expect(harness.api.messages).toHaveLength(2);
    expect(harness.api.messages[0]?.text).toContain('title: Product name');
    expect(harness.api.messages[0]?.text).toContain('daily limit is 8');
    expect(harness.api.messages[1]?.text).toContain('price: 1,499');
    expect(harness.api.channelMessages()).toHaveLength(0);
  });

  it('ignores a non-owner confirm tap', async () => {
    harness = await createHarness();
    const preview = await sendDeal(harness);
    const data = callbackData(preview, 'Post to channel');

    await harness.app.onCallback({
      chatId: 2,
      userId: OTHER_ID,
      callbackId: 'other',
      data,
    });

    expect(harness.api.answered).toEqual([]);
    expect(harness.api.channelMessages()).toHaveLength(0);
    expect(harness.api.messages.every((message) => message.chatId !== CHANNEL)).toBe(true);
  });
});
