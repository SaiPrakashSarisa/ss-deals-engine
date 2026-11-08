import { formatPaise } from '../../lib/money';

export type UrlBanner = {
  tone: 'good' | 'warn' | 'bad' | 'calm';
  text: string;
  detail?: string;
};

export type UrlCheckPayload = {
  code: string;
  problems: string[];
  previousPricePaise: number | null;
  newPricePaise: number | null;
};

export function bannerForCheck(check: UrlCheckPayload): UrlBanner {
  if (check.code === 'invalid') {
    return { tone: 'bad', text: check.problems[0] ?? 'That product link is not valid.' };
  }
  if (check.code === 'in_queue') {
    return { tone: 'bad', text: 'Already in the queue' };
  }
  if (check.code === 'editing') {
    return { tone: 'calm', text: 'Editing your deal' };
  }
  if (check.code === 'posted_lower') {
    const from = check.previousPricePaise === null ? '' : formatPaise(check.previousPricePaise);
    const to = check.newPricePaise === null ? '' : formatPaise(check.newPricePaise);
    const numbers = from.length > 0 && to.length > 0 ? ` (${from} to ${to})` : '';
    return {
      tone: 'warn',
      text: `Posted before; allowed because the price is lower${numbers}`,
    };
  }
  if (check.code === 'posted_unknown_price') {
    return {
      tone: 'bad',
      text: 'Already posted',
      detail: 'Ask an admin to check the earlier price.',
    };
  }
  if (check.code === 'posted_blocked') {
    return {
      tone: 'bad',
      text: 'Already posted',
      detail: 'The new price has to be lower than the last posted price.',
    };
  }
  if (check.code === 'awaiting_price') {
    return {
      tone: 'bad',
      text: 'Already posted',
      detail:
        check.previousPricePaise === null
          ? undefined
          : `Last posted price was ${formatPaise(check.previousPricePaise)}. Enter a lower price.`,
    };
  }
  return { tone: 'good', text: 'OK' };
}

export function checkAllowsSave(code: string | null, unknownConfirmed = false): boolean {
  return (
    code === 'ok' ||
    code === 'posted_lower' ||
    code === 'editing' ||
    (code === 'posted_unknown_price' && unknownConfirmed)
  );
}
