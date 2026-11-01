import { describe, expect, it } from 'vitest';
import { SHORT_LINK_MESSAGE, parseAmazonProductUrl } from '../src/amazon/url.js';

const tag = 'ssdeals-21';
const asin = 'B0CABCDEFG';
const canonical = `https://www.amazon.in/dp/${asin}?tag=${tag}`;

describe('parseAmazonProductUrl', () => {
  it('accepts /dp/ links and rebuilds a tagged url', () => {
    expect(
      parseAmazonProductUrl(
        'https://www.amazon.in/Some-Product-Name/dp/B0CABCDEFG/ref=sr_1_1?keywords=bottle&qid=1',
        tag,
      ),
    ).toEqual({ ok: true, asin, url: canonical });
  });

  it('accepts /gp/product/ links on the bare and mobile hosts', () => {
    expect(parseAmazonProductUrl('https://amazon.in/gp/product/B0CABCDEFG', tag)).toEqual({
      ok: true,
      asin,
      url: canonical,
    });
    expect(parseAmazonProductUrl('http://m.amazon.in/dp/b0cabcdefg?psc=1', tag)).toEqual({
      ok: true,
      asin,
      url: canonical,
    });
  });

  it('drops foreign tags, extra query parameters, fragments, and userinfo', () => {
    const result = parseAmazonProductUrl(
      'https://user:pass@www.amazon.in/dp/B0CABCDEFG?tag=other-21&psc=1&linkCode=ll1#reviews',
      tag,
    );

    expect(result).toEqual({ ok: true, asin, url: canonical });
    if (result.ok) {
      const url = new URL(result.url);
      expect(url.searchParams.get('tag')).toBe(tag);
      expect([...url.searchParams.keys()]).toEqual(['tag']);
      expect(url.hash).toBe('');
      expect(url.username).toBe('');
      expect(url.password).toBe('');
    }
  });

  it('rejects domains other than amazon.in', () => {
    expect(parseAmazonProductUrl('https://www.amazon.com/dp/B0CABCDEFG', tag).ok).toBe(false);
    expect(parseAmazonProductUrl('https://www.flipkart.com/product/B0CABCDEFG', tag).ok).toBe(
      false,
    );
    expect(parseAmazonProductUrl('https://amazon.in.evil.com/dp/B0CABCDEFG', tag).ok).toBe(false);
  });

  it('rejects short links with a specific message', () => {
    expect(parseAmazonProductUrl('https://amzn.to/3abcXYZ', tag)).toEqual({
      ok: false,
      message: SHORT_LINK_MESSAGE,
    });
    expect(parseAmazonProductUrl('https://a.co/d/short', tag)).toEqual({
      ok: false,
      message: SHORT_LINK_MESSAGE,
    });
  });

  it('rejects an invalid ASIN', () => {
    expect(parseAmazonProductUrl('https://www.amazon.in/dp/SHORT', tag)).toMatchObject({
      ok: false,
    });
    expect(parseAmazonProductUrl('https://www.amazon.in/dp/B0TOOLONGASIN', tag)).toMatchObject({
      ok: false,
    });
    expect(parseAmazonProductUrl('https://www.amazon.in/gp/product/B0-ABCDEFG', tag)).toMatchObject(
      { ok: false },
    );
    expect(parseAmazonProductUrl('https://www.amazon.in/s?k=bottle', tag)).toMatchObject({
      ok: false,
    });
  });
});
