import { describe, expect, it } from 'vitest';
import {
  AMAZON_BUTTON_LABEL,
  MAX_CAPTION_LENGTH,
  discountPercent,
  formatPost,
  type FormatInput,
} from '../src/format/post.js';

const taggedUrl = 'https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21';

function input(overrides: Partial<FormatInput> = {}): FormatInput {
  return {
    title: 'Bottle',
    price: 1499,
    verified: false,
    highlights: [],
    linkUrl: taggedUrl,
    linkStyle: 'text',
    ...overrides,
  };
}

function expectPlainCaption(html: string): void {
  expect(html.toLowerCase()).not.toContain('blockquote');
  expect(html).not.toContain('<a');
}

describe('formatPost', () => {
  it('lays out a verified price with Indian grouping and a plain link', () => {
    const result = formatPost(
      input({
        price: 1000,
        oldPrice: 3000,
        verified: true,
        highlights: ['Cold', 'Light'],
        offer: 'Bank',
      }),
    );

    expect(discountPercent(1000, 3000)).toBe(67);
    expect(discountPercent(1, 8)).toBe(88);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.html).toBe(
      [
        '🔥 <b>Bottle</b>',
        '🎁 <b>Deal Price : ₹1,000</b>  <s>₹3,000</s>\n🟢 <b>67% off</b>\n💳 Offer: Bank',
        '✨ Cold\n✨ Light',
        `🛒 Buy Here : ${taggedUrl}`,
      ].join('\n\n'),
    );
    expect(result.urlButton).toBeUndefined();
    expect(result.html).not.toContain('Listed at');
    expect(result.html).not.toContain('earlier');
    expectPlainCaption(result.html);
  });

  it('lists an unverified old price without a percentage', () => {
    const result = formatPost(input({ oldPrice: 2499, verified: false }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.html).toContain('🎁 <b>Deal Price : ₹1,499</b>\nListed at ₹2,499');
    expect(result.html).not.toContain('%');
    expect(result.html).not.toContain('<s>');
    expect(result.html).not.toContain('earlier');
    expect(result.html).not.toContain('% off');
    expectPlainCaption(result.html);
  });

  it('shows only the deal price when no old price is given', () => {
    const result = formatPost(input({ price: 1499 }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.html).toContain('🎁 <b>Deal Price : ₹1,499</b>');
    expect(result.html).not.toContain('Listed at');
    expect(result.html).not.toContain('<s>');
    expect(result.html).not.toContain('% off');
    expectPlainCaption(result.html);
  });

  it('escapes HTML in the title, highlights, and offer', () => {
    const result = formatPost(
      input({
        title: 'A & B <C>',
        highlights: ['1 < 2'],
        offer: '5% & <cash>',
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.html).toContain('🔥 <b>A &amp; B &lt;C&gt;</b>');
    expect(result.html).toContain('✨ 1 &lt; 2');
    expect(result.html).toContain('💳 Offer: 5% &amp; &lt;cash&gt;');
    expect(result.html).not.toContain('<C>');
    expect(result.html).not.toContain('<cash>');
    expectPlainCaption(result.html);
  });

  it('omits the offer line when no offer is set', () => {
    const result = formatPost(input());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).not.toContain('Offer');
    }
  });

  it('groups rupees in the Indian format', () => {
    const result = formatPost(input({ price: 149999, oldPrice: 200000, verified: true }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.html).toContain('🎁 <b>Deal Price : ₹1,49,999</b>  <s>₹2,00,000</s>');
    expect(result.html).toContain('🟢 <b>25% off</b>');
    expectPlainCaption(result.html);
  });

  it('rounds a half percent up', () => {
    const result = formatPost(input({ price: 1, oldPrice: 8, verified: true }));
    expect(discountPercent(1, 8)).toBe(88);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain('🟢 <b>88% off</b>');
    }
  });

  it('appends an escaped footer and omits an empty one', () => {
    const empty = formatPost(input({ footer: '' }));
    const missing = formatPost(input());
    const set = formatPost(input({ footer: 'A & B <C>' }));

    expect(empty.ok && missing.ok && set.ok).toBe(true);
    if (!empty.ok || !missing.ok || !set.ok) {
      return;
    }
    expect(empty.html).not.toContain('<i>');
    expect(missing.html).not.toContain('<i>');
    expect(set.html.endsWith('\n\n<i>A &amp; B &lt;C&gt;</i>')).toBe(true);
    expect(set.html).not.toContain('<C>');
    expectPlainCaption(empty.html);
    expectPlainCaption(set.html);
  });

  it('shows a plain link, a button, or both', () => {
    const shortUrl = 'https://amzn.to/abc?x=1&y=2';
    const text = formatPost(input({ linkUrl: shortUrl, linkStyle: 'text' }));
    const button = formatPost(input({ linkUrl: shortUrl, linkStyle: 'button' }));
    const both = formatPost(input({ linkUrl: shortUrl, linkStyle: 'both' }));

    expect(text.ok && button.ok && both.ok).toBe(true);
    if (!text.ok || !button.ok || !both.ok) {
      return;
    }
    expect(text.html).toContain('🛒 Buy Here : https://amzn.to/abc?x=1&amp;y=2');
    expect(text.urlButton).toBeUndefined();
    expect(button.html).not.toContain('Buy Here');
    expect(button.urlButton).toEqual({ text: AMAZON_BUTTON_LABEL, url: shortUrl });
    expect(both.html).toContain('🛒 Buy Here : https://amzn.to/abc?x=1&amp;y=2');
    expect(both.urlButton).toEqual({ text: AMAZON_BUTTON_LABEL, url: shortUrl });
    expectPlainCaption(text.html);
    expectPlainCaption(button.html);
    expectPlainCaption(both.html);
  });

  it('warns about forbidden words without removing them', () => {
    const result = formatPost(
      input({
        title: 'HURRY for this bottle',
        highlights: ['lowest ever price', 'last chance today', 'fine print'],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.warnings).toEqual([
      'The title or highlights include: hurry, last chance, lowest ever.',
    ]);
    expect(result.html).toContain('HURRY for this bottle');
  });

  it('does not warn when a forbidden phrase is only a partial word', () => {
    const result = formatPost(input({ title: 'Last item in the cupboard' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toEqual([]);
    }
  });

  it('rejects a caption that is not under 900 characters, counting tags', () => {
    const probe = formatPost(input({ title: 'A' }));
    expect(probe.ok).toBe(true);
    if (!probe.ok) {
      return;
    }
    expect(probe.html).toContain('<b>');
    expect(probe.html.toLowerCase()).not.toContain('blockquote');
    const room = MAX_CAPTION_LENGTH - 1 - (probe.html.length - 1);
    const accepted = formatPost(input({ title: 'B'.repeat(room) }));
    const rejected = formatPost(input({ title: 'B'.repeat(room + 1) }));

    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.html.length).toBe(MAX_CAPTION_LENGTH - 1);
      expectPlainCaption(accepted.html);
    }
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.message).toContain('under 900');
    }
  });
});
