import http from 'node:http';
import https from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import { SHORT_LINK_MESSAGE } from '../src/amazon/url.js';
import { parseDealMessage, shortLinkError } from '../src/parse/message.js';

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
        'offer: 10% bank',
        'short: https://amzn.to/deal',
        'preview: off',
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
        offer: '10% bank',
        shortUrl: 'https://amzn.to/deal',
        linkPreview: false,
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

  it('keeps the tagged link when an allowed short link is also present', () => {
    const result = parseDealMessage(
      message(['short: https://link.amazon/promo', url, 'title: Bottle', 'price: 1499']),
      tag,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.asin).toBe('B0CABCDEFG');
      expect(result.draft.taggedUrl).toBe('https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21');
      expect(result.draft.shortUrl).toBe('https://link.amazon/promo');
    }
  });

  it('rejects a short link whose host is not allowed', () => {
    const hosts = ['amzn.to', 'link.amazon'];
    const result = parseDealMessage(
      message([url, 'title: Bottle', 'price: 1499', 'short: https://evil.example/deal']),
      tag,
      { shortLinkHosts: hosts },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(shortLinkError(hosts));
    }
  });

  it.each([
    'http://amzn.to/abc',
    'https://www.amzn.to/abc',
    'https://amzn.to.evil.com/abc',
    'not a link',
  ])('rejects short link %s', (short) => {
    const result = parseDealMessage(
      message([url, 'title: Bottle', 'price: 1499', `short: ${short}`]),
      tag,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(shortLinkError(['amzn.to', 'link.amazon']));
    }
  });

  it('accepts a custom short-link host without calling the network', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const httpSpy = vi.spyOn(http, 'request').mockImplementation(() => {
      throw new Error('network');
    });
    const httpsSpy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new Error('network');
    });

    try {
      const result = parseDealMessage(
        message([url, 'title: Bottle', 'price: 1499', 'short: https://shr.example/deal']),
        tag,
        { shortLinkHosts: ['shr.example'] },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.draft.shortUrl).toBe('https://shr.example/deal');
        expect(result.draft.taggedUrl).toBe('https://www.amazon.in/dp/B0CABCDEFG?tag=ssdeals-21');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(httpSpy).not.toHaveBeenCalled();
      expect(httpsSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
    }
  });

  it('rejects an offer longer than 120 characters', () => {
    const accepted = parseDealMessage(
      message([url, 'title: Bottle', 'price: 1499', `offer: ${'a'.repeat(120)}`]),
      tag,
    );
    const rejected = parseDealMessage(
      message([url, 'title: Bottle', 'price: 1499', `offer: ${'a'.repeat(121)}`]),
      tag,
    );

    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.draft.offer).toHaveLength(120);
    }
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.errors).toContain('Offer must be 120 characters or fewer.');
    }
  });

  it('rejects a preview value other than on or off', () => {
    const result = parseDealMessage(
      message([url, 'title: Bottle', 'price: 1499', 'preview: maybe']),
      tag,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain('Preview must be on or off.');
    }
  });
});
