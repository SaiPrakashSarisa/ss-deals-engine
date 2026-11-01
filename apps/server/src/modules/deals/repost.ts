export const repostReasons = [
  'first_post',
  'price_lower',
  'price_not_lower',
  'previous_price_unknown',
] as const;

export type RepostReason = (typeof repostReasons)[number];

export type RepostPrevious = {
  postedPricePaise: number | null;
};

export type RepostDecision = {
  allowed: boolean;
  reason: RepostReason;
};

/**
 * A product may be submitted again only when the new price is strictly below
 * the price shown on the latest published post. An unknown previous price
 * fails closed so a later owner override can decide explicitly.
 */
export function evaluateRepost(input: {
  previous: RepostPrevious | null;
  newPricePaise: number;
}): RepostDecision {
  if (input.previous === null) {
    return { allowed: true, reason: 'first_post' };
  }

  if (input.previous.postedPricePaise === null) {
    return { allowed: false, reason: 'previous_price_unknown' };
  }

  if (input.newPricePaise < input.previous.postedPricePaise) {
    return { allowed: true, reason: 'price_lower' };
  }

  return { allowed: false, reason: 'price_not_lower' };
}
