import { describe, expect, it } from 'vitest';
import { classifyUrlCheck, urlCheckBlocksSave } from '../../src/modules/deals/check.js';

describe('classifyUrlCheck', () => {
  it('allows a first post', () => {
    expect(
      classifyUrlCheck({
        urlOk: false,
        activeDeal: false,
        previous: null,
        newPricePaise: null,
      }).code,
    ).toBe('invalid');
    expect(
      classifyUrlCheck({
        urlOk: true,
        activeDeal: false,
        previous: null,
        newPricePaise: 149_900,
      }),
    ).toEqual({ code: 'ok', repost: { allowed: true, reason: 'first_post' } });
  });

  it('blocks a product that is already active', () => {
    const result = classifyUrlCheck({
      urlOk: true,
      activeDeal: true,
      previous: null,
      newPricePaise: 100,
    });
    expect(result.code).toBe('in_queue');
    expect(urlCheckBlocksSave(result.code)).toBe(true);
  });

  it('maps a lower price to allowed and an equal or higher price to blocked', () => {
    const lower = classifyUrlCheck({
      urlOk: true,
      activeDeal: false,
      previous: { postedPricePaise: 200_000 },
      newPricePaise: 199_900,
    });
    expect(lower).toEqual({
      code: 'posted_lower',
      repost: { allowed: true, reason: 'price_lower' },
    });
    expect(urlCheckBlocksSave(lower.code)).toBe(false);

    expect(
      classifyUrlCheck({
        urlOk: true,
        activeDeal: false,
        previous: { postedPricePaise: 200_000 },
        newPricePaise: 200_000,
      }).code,
    ).toBe('posted_blocked');
    expect(
      classifyUrlCheck({
        urlOk: true,
        activeDeal: false,
        previous: { postedPricePaise: 200_000 },
        newPricePaise: 200_100,
      }).code,
    ).toBe('posted_blocked');
  });

  it('fails closed when the earlier posted price is missing', () => {
    expect(
      classifyUrlCheck({
        urlOk: true,
        activeDeal: false,
        previous: { postedPricePaise: null },
        newPricePaise: 100,
      }),
    ).toEqual({
      code: 'posted_unknown_price',
      repost: { allowed: false, reason: 'previous_price_unknown' },
    });
  });

  it('waits for a price when the product was posted before', () => {
    expect(
      classifyUrlCheck({
        urlOk: true,
        activeDeal: false,
        previous: { postedPricePaise: 200_000 },
        newPricePaise: null,
      }).code,
    ).toBe('awaiting_price');
  });
});
