import { evaluateRepost, type RepostDecision, type RepostPrevious } from './repost.js';

export const urlCheckCodes = [
  'invalid',
  'in_queue',
  'posted_blocked',
  'posted_unknown_price',
  'posted_lower',
  'awaiting_price',
  'editing',
  'ok',
] as const;

export type UrlCheckCode = (typeof urlCheckCodes)[number];

export type UrlCheck = {
  ok: boolean;
  asin: string | null;
  problems: string[];
  code: UrlCheckCode;
  activeDeal: boolean;
  repost: RepostDecision | null;
  previousPricePaise: number | null;
  newPricePaise: number | null;
  taggedUrl: string | null;
  allowUnknownPriceConfirm: boolean;
};

/**
 * Maps a parsed product link, an active-deal flag, and the latest published
 * price onto the banner the form shows. This does not read the network.
 */
export function classifyUrlCheck(input: {
  urlOk: boolean;
  activeDeal: boolean;
  previous: RepostPrevious | null;
  newPricePaise: number | null;
  editingOwnActive?: boolean;
}): { code: UrlCheckCode; repost: RepostDecision | null } {
  if (!input.urlOk) {
    return { code: 'invalid', repost: null };
  }

  const repost =
    input.newPricePaise === null
      ? input.previous === null
        ? { allowed: true, reason: 'first_post' as const }
        : input.previous.postedPricePaise === null
          ? { allowed: false, reason: 'previous_price_unknown' as const }
          : null
      : evaluateRepost({ previous: input.previous, newPricePaise: input.newPricePaise });

  if (input.activeDeal) {
    return { code: 'in_queue', repost };
  }
  if (input.previous === null) {
    return {
      code: input.editingOwnActive === true ? 'editing' : 'ok',
      repost: { allowed: true, reason: 'first_post' },
    };
  }
  if (repost?.reason === 'previous_price_unknown') {
    return { code: 'posted_unknown_price', repost };
  }
  if (input.newPricePaise === null) {
    return { code: 'awaiting_price', repost: null };
  }
  if (repost?.reason === 'price_lower') {
    return { code: 'posted_lower', repost };
  }
  return { code: 'posted_blocked', repost };
}

export function urlCheckBlocksSave(code: UrlCheckCode): boolean {
  return code !== 'ok' && code !== 'posted_lower' && code !== 'editing';
}
