import { describe, expect, it } from 'vitest';
import { parseCheckBody, parseDealBody } from '../../src/modules/deals/validation.js';

const options = { amazonTag: 'example-21', shortLinkHosts: ['amzn.to', 'link.amazon'] };

function deal(overrides: Record<string, unknown> = {}) {
  return {
    productUrl: 'https://www.amazon.in/dp/B0TEST1234',
    title: 'Blue kettle',
    price: '1499',
    ...overrides,
  };
}

describe('parseDealBody', () => {
  it('converts a pasted rupee price into paise and tags the product link', () => {
    const parsed = parseDealBody(deal({ price: '₹1,499', oldPrice: '2,000' }), options);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.pricePaise).toBe(149_900);
    expect(parsed.value.oldPricePaise).toBe(200_000);
    expect(parsed.value.asin).toBe('B0TEST1234');
    expect(parsed.value.taggedUrl).toBe('https://www.amazon.in/dp/B0TEST1234?tag=example-21');
    expect(parsed.value.shortLink).toBeNull();
  });

  it('accepts a grouped price without a symbol', () => {
    const parsed = parseDealBody(deal({ price: '1,499' }), options);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.pricePaise).toBe(149_900);
    }
  });

  it('rejects a short link that is not https on an allowed host', () => {
    expect(parseDealBody(deal({ shortLink: 'http://amzn.to/abc' }), options).ok).toBe(false);
    expect(parseDealBody(deal({ shortLink: 'https://evil.example/abc' }), options).ok).toBe(false);
    const allowed = parseDealBody(deal({ shortLink: 'https://amzn.to/abc' }), options);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.value.shortLink).toBe('https://amzn.to/abc');
    }
  });

  it('rejects an old price that is not higher, and enforces field limits', () => {
    const same = parseDealBody(deal({ price: '100', oldPrice: '100' }), options);
    expect(same.ok).toBe(false);
    if (!same.ok) {
      expect(same.fields.oldPrice).toMatch(/higher/);
    }

    const title = parseDealBody(deal({ title: 'a'.repeat(201) }), options);
    expect(title.ok).toBe(false);
    if (!title.ok) {
      expect(title.fields.title).toMatch(/200/);
    }

    const offer = parseDealBody(deal({ offer: 'b'.repeat(121) }), options);
    expect(offer.ok).toBe(false);
    if (!offer.ok) {
      expect(offer.fields.offer).toMatch(/120/);
    }

    const notes = parseDealBody(deal({ clerkNotes: 'c'.repeat(301) }), options);
    expect(notes.ok).toBe(false);
    if (!notes.ok) {
      expect(notes.fields.clerkNotes).toMatch(/300/);
    }

    const source = parseDealBody(deal({ sourceNote: 'd'.repeat(121) }), options);
    expect(source.ok).toBe(false);
    if (!source.ok) {
      expect(source.fields.sourceNote).toMatch(/120/);
    }

    const highlight = parseDealBody(deal({ highlights: ['e'.repeat(81)] }), options);
    expect(highlight.ok).toBe(false);
    if (!highlight.ok) {
      expect(highlight.fields.highlights).toMatch(/80/);
    }

    const tooMany = parseDealBody(deal({ highlights: ['a', 'b', 'c', 'd'] }), options);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.fields.highlights).toMatch(/3/);
    }
  });

  it('rejects a missing price, a decimal, and a non-product link', () => {
    const missing = parseDealBody(deal({ price: '' }), options);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.fields.price).toMatch(/whole rupees/);
    }
    const decimal = parseDealBody(deal({ price: '12.50' }), options);
    expect(decimal.ok).toBe(false);
    const other = parseDealBody(deal({ productUrl: 'https://example.com/dp/B0TEST1234' }), options);
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.fields.productUrl).toMatch(/amazon\.in/);
    }
  });
});

describe('parseCheckBody', () => {
  it('keeps a usable price and ignores a price that is not a whole number of rupees', () => {
    const parsed = parseCheckBody({ url: 'https://www.amazon.in/dp/B0TEST1234', price: '₹1,499' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.pricePaise).toBe(149_900);
    }
    const skipped = parseCheckBody({ url: 'https://www.amazon.in/dp/B0TEST1234', price: '12.50' });
    expect(skipped.ok).toBe(true);
    if (skipped.ok) {
      expect(skipped.value.pricePaise).toBeNull();
    }
  });
});
