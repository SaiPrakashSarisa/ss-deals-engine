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
    taggedUrl,
    ...overrides,
  };
}

describe('formatPost', () => {
  it('shows a verified old price with the rounded percentage', () => {
    const result = formatPost(
      input({
        price: 1000,
        oldPrice: 3000,
        verified: true,
        highlights: ['Cold', 'Light'],
      }),
    );

    expect(discountPercent(1000, 3000)).toBe(67);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.html).toBe(
      [
        '<b>🛍️ Bottle</b>',
        '<b>₹1,000 when posted (may change)</b>',
        '<s>₹3,000</s> 67% lower',
        '• Cold\n• Light',
        '<i>Affiliate link: I may earn a commission at no extra cost to you.</i>\n<i>As an Amazon Associate I earn from qualifying purchases.</i>',
      ].join('\n\n'),
    );
    expect(result.urlButton).toEqual({ text: AMAZON_BUTTON_LABEL, url: taggedUrl });
    expect(result.html).not.toContain('Listed at');
  });

  it('lists an unverified old price without a percentage', () => {
    const result = formatPost(input({ oldPrice: 2499, verified: false }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.html).toContain('Listed at ₹2,499');
    expect(result.html).not.toContain('%');
    expect(result.html).not.toContain('<s>');
  });

  it('escapes HTML in the title and highlights', () => {
    const result = formatPost(
      input({
        title: 'A & B <C>',
        highlights: ['1 < 2'],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.html).toContain('<b>🛍️ A &amp; B &lt;C&gt;</b>');
    expect(result.html).toContain('• 1 &lt; 2');
    expect(result.html).not.toContain('<C>');
  });

  it('groups rupees in the Indian format', () => {
    const result = formatPost(input({ price: 149999, oldPrice: 200000, verified: true }));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.html).toContain('₹1,49,999');
    expect(result.html).toContain('₹2,00,000');
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

  it('rejects a caption that is not under 900 characters', () => {
    const probe = formatPost(input({ title: 'A' }));
    expect(probe.ok).toBe(true);
    if (!probe.ok) {
      return;
    }
    const room = MAX_CAPTION_LENGTH - 1 - (probe.html.length - 1);
    const accepted = formatPost(input({ title: 'B'.repeat(room) }));
    const rejected = formatPost(input({ title: 'B'.repeat(room + 1) }));

    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.html.length).toBe(MAX_CAPTION_LENGTH - 1);
    }
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.message).toContain('under 900');
    }
  });
});
