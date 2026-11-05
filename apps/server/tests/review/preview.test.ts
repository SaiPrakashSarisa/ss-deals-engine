import { describe, expect, it } from 'vitest';
import { buildDealPreview } from '../../src/modules/review/preview.js';

describe('buildDealPreview', () => {
  const shortLinkHosts = ['amzn.to', 'link.amazon'];

  it('builds a post preview with character count and text link', () => {
    const preview = buildDealPreview(
      {
        title: 'Sony Wireless Headphones',
        pricePaise: 499900,
        oldPricePaise: 799900,
        highlights: ['Active Noise Cancellation', '30hr Battery'],
        offerText: 'Bank discount ₹500',
        shortLink: 'https://amzn.to/sony123',
        taggedUrl: 'https://www.amazon.in/dp/B000TEST12?tag=example-21',
      },
      shortLinkHosts,
    );

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.characterCount).toBe(preview.html.length);
    expect(preview.characterCount).toBe(preview.caption.length);
    expect(preview.html).toContain('Sony Wireless Headphones');
    expect(preview.html).toContain('₹4,999');
    expect(preview.html).toContain('Listed at ₹7,999');
    expect(preview.html).toContain('https://amzn.to/sony123');
    expect(preview.html).toContain('💳 Offer: Bank discount ₹500');
    expect(preview.warnings).toEqual([]);
    expect(preview.forbiddenWords).toEqual([]);
  });

  it('detects forbidden words and surfaces warnings', () => {
    const preview = buildDealPreview(
      {
        title: 'Hurry! Limited time loot on kettle',
        pricePaise: 99900,
        oldPricePaise: null,
        highlights: ['Lowest ever price', 'Steel'],
        offerText: null,
        shortLink: null,
        taggedUrl: 'https://www.amazon.in/dp/B000TEST99?tag=example-21',
      },
      shortLinkHosts,
    );

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.forbiddenWords).toEqual(
      expect.arrayContaining(['hurry', 'limited time', 'loot', 'lowest ever']),
    );
    expect(preview.warnings.length).toBeGreaterThan(0);
    expect(preview.warnings[0]).toContain('The title or highlights include:');
    expect(preview.warnings[0]).toContain('hurry');
  });

  it('falls back to tagged URL if short link host is not allowed', () => {
    const preview = buildDealPreview(
      {
        title: 'USB-C Cable',
        pricePaise: 29900,
        oldPricePaise: null,
        highlights: ['Braided'],
        offerText: null,
        shortLink: 'https://untrusted.com/short1',
        taggedUrl: 'https://www.amazon.in/dp/B000CABLE1?tag=example-21',
      },
      shortLinkHosts,
    );

    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.html).toContain('https://www.amazon.in/dp/B000CABLE1?tag=example-21');
    expect(preview.html).not.toContain('untrusted.com');
  });

  it('handles caption exceeding maximum length', () => {
    const preview = buildDealPreview(
      {
        title: 'A'.repeat(1000),
        pricePaise: 10000,
        oldPricePaise: null,
        highlights: [],
        offerText: null,
        shortLink: null,
        taggedUrl: 'https://www.amazon.in/dp/B000LONG12?tag=example-21',
      },
      shortLinkHosts,
    );

    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.message).toContain('Keep the caption under 900 characters');
    expect(preview.characterCount).toBe(0);
  });
});
