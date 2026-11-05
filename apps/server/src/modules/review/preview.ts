import { findForbiddenWords, formatPost, paiseToRupees, validateShortLink } from '@ss-deals/core';

export type DealPreviewResult =
  | {
      ok: true;
      html: string;
      caption: string;
      characterCount: number;
      warnings: string[];
      forbiddenWords: string[];
    }
  | {
      ok: false;
      message: string;
      characterCount: number;
      warnings: string[];
      forbiddenWords: string[];
    };

export function buildDealPreview(
  deal: {
    title: string;
    pricePaise: number;
    oldPricePaise: number | null;
    highlights: string[];
    offerText: string | null;
    shortLink: string | null;
    taggedUrl: string;
  },
  shortLinkHosts: readonly string[],
): DealPreviewResult {
  const title = deal.title.trim();
  const priceRupees = paiseToRupees(deal.pricePaise);
  const oldPriceRupees =
    deal.oldPricePaise !== null ? paiseToRupees(deal.oldPricePaise) : undefined;
  const shortLink = deal.shortLink?.trim() ?? '';
  const shortOk = shortLink.length > 0 && validateShortLink(shortLink, shortLinkHosts).ok;
  const linkUrl = shortOk ? shortLink : deal.taggedUrl;
  const highlights = deal.highlights
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  const offer = deal.offerText?.trim() ? deal.offerText.trim() : undefined;

  const forbiddenWords = findForbiddenWords([title, ...highlights].join('\n'));

  const result = formatPost({
    title,
    price: priceRupees,
    oldPrice:
      oldPriceRupees !== undefined && oldPriceRupees > priceRupees ? oldPriceRupees : undefined,
    verified: false,
    highlights,
    offer,
    linkUrl,
    linkStyle: 'text',
  });

  if (!result.ok) {
    return {
      ok: false,
      message: result.message,
      characterCount: 0,
      warnings: [],
      forbiddenWords,
    };
  }

  return {
    ok: true,
    html: result.html,
    caption: result.html,
    characterCount: result.html.length,
    warnings: result.warnings,
    forbiddenWords,
  };
}
