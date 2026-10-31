import { describe, expect, it } from 'vitest';
import { SHORT_LINK_MESSAGE } from '../src/amazon/url.js';
import { parseDealMessage } from '../src/parse/message.js';

const tag = 'ssdeals-21';
const url = 'https://www.amazon.in/Stainless-Bottle/dp/B0CABCDEFG?tag=other-21&psc=1#reviews';

function message(lines: string[]): string {
  return lines.join('\n');
}

describe('parseDealMessage', () => {
  it('parses every field', () => {
    const result = parseDealMessage(
      message([
        url,
        'title: Stainless Bottle',
        'price: ₹2,499',
        'old: 3,999',
        'verified: yes',
        '- Keeps water cold',
        '- Light',
      ]),
      tag,
    );

    expect(result).toEqual({
      ok: true,
      draft: {
        asin: 'B0CABCDEFG',
        taggedUrl: 'https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21',
        title: 'Stainless Bottle',
        price: 2499,
        oldPrice: 3999,
        verified: true,
        highlights: ['Keeps water cold', 'Light'],
      },
    });
  });

  it('defaults optional fields', () => {
    const result = parseDealMessage(message([url, 'title: Bottle', 'price: 1499']), tag);

    expect(result).toEqual({
      ok: true,
      draft: {
        asin: 'B0CABCDEFG',
        taggedUrl: 'https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21',
        title: 'Bottle',
        price: 1499,
        verified: false,
        highlights: [],
      },
    });
  });

  it.each(['1,499', '1499', '₹1,499'])('accepts price %s', (price) => {
    const result = parseDealMessage(message([url, 'title: Bottle', `price: ${price}`]), tag);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.price).toBe(1499);
    }
  });

  it('accepts Indian grouping', () => {
    const result = parseDealMessage(message([url, 'title: Bottle', 'price: 1,49,999']), tag);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.price).toBe(149999);
    }
  });

  it('collects highlight lines', () => {
    const result = parseDealMessage(
      message([url, 'title: Bottle', 'price: 1499', '- First', '-', '- Second']),
      tag,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.highlights).toEqual(['First', 'Second']);
    }
  });

  it('lists a missing title', () => {
    const result = parseDealMessage(message([url, 'price: 1499']), tag);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('Add a title: line.');
    }
  });

  it('lists every problem in one result', () => {
    const result = parseDealMessage(
      message(['title: ', 'price: 14.99', 'old: free', 'verified: maybe']),
      tag,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        'Paste the full amazon.in product link.',
        'Add a title: line.',
        'Price must be a positive whole number of rupees, such as 1499 or ₹1,499.',
        'Old price must be a positive whole number of rupees.',
        'Verified must be yes or no.',
      ]);
    }
  });

  it('rejects an old price that is not higher', () => {
    const result = parseDealMessage(
      message([url, 'title: Bottle', 'price: 1499', 'old: 1499']),
      tag,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('Old price must be greater than the current price.');
    }
  });

  it('surfaces the short-link message', () => {
    const result = parseDealMessage(
      message(['https://amzn.to/abc', 'title: Bottle', 'price: 1499']),
      tag,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(SHORT_LINK_MESSAGE);
    }
  });
});
