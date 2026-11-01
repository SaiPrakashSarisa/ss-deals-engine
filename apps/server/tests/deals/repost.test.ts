import { describe, expect, it } from 'vitest';
import { evaluateRepost } from '../../src/modules/deals/repost.js';

describe('evaluateRepost', () => {
  it('allows the first post when there is no previous publication', () => {
    expect(evaluateRepost({ previous: null, newPricePaise: 19900 })).toEqual({
      allowed: true,
      reason: 'first_post',
    });
  });

  it('allows a price that is one paise lower', () => {
    expect(
      evaluateRepost({
        previous: { postedPricePaise: 19900 },
        newPricePaise: 19899,
      }),
    ).toEqual({
      allowed: true,
      reason: 'price_lower',
    });
  });

  it('rejects an equal price', () => {
    expect(
      evaluateRepost({
        previous: { postedPricePaise: 19900 },
        newPricePaise: 19900,
      }),
    ).toEqual({
      allowed: false,
      reason: 'price_not_lower',
    });
  });

  it('rejects a higher price', () => {
    expect(
      evaluateRepost({
        previous: { postedPricePaise: 19900 },
        newPricePaise: 19901,
      }),
    ).toEqual({
      allowed: false,
      reason: 'price_not_lower',
    });
  });

  it('rejects a repost when the previous posted price is unknown', () => {
    expect(
      evaluateRepost({
        previous: { postedPricePaise: null },
        newPricePaise: 1,
      }),
    ).toEqual({
      allowed: false,
      reason: 'previous_price_unknown',
    });
  });
});
