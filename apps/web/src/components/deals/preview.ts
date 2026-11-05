import { formatPost, parsePriceInput, validateShortLink, type FormatResult } from '@ss-deals/core';

export type PreviewFields = {
  title: string;
  price: string;
  oldPrice: string;
  offer: string;
  highlights: string[];
  shortLink: string;
  taggedUrl: string | null;
};

export function formatDealPreview(
  input: PreviewFields,
  shortLinkHosts: readonly string[] | null,
): FormatResult | undefined {
  const amount = parsePriceInput(input.price);
  const title = input.title.trim();
  if (amount === undefined || title.length === 0 || input.taggedUrl === null) {
    return undefined;
  }
  const oldAmount = input.oldPrice.trim() === '' ? undefined : parsePriceInput(input.oldPrice);
  const shortLink = input.shortLink.trim();
  const shortOk =
    shortLink.length > 0 &&
    shortLinkHosts !== null &&
    validateShortLink(shortLink, shortLinkHosts).ok;
  return formatPost({
    title,
    price: amount,
    oldPrice: oldAmount !== undefined && oldAmount > amount ? oldAmount : undefined,
    verified: false,
    highlights: input.highlights.map((item) => item.trim()).filter((item) => item.length > 0),
    offer: input.offer.trim() === '' ? undefined : input.offer.trim(),
    linkUrl: shortOk ? shortLink : input.taggedUrl,
    linkStyle: 'text',
  });
}

export function previewFieldsFromStored(deal: {
  title: string | null;
  pricePaise: number;
  oldPricePaise: number | null;
  highlights: string[];
  offer: string | null;
  shortLink: string | null;
  taggedUrl: string | null;
}): PreviewFields {
  return {
    title: deal.title ?? '',
    price: String(deal.pricePaise / 100),
    oldPrice: deal.oldPricePaise === null ? '' : String(deal.oldPricePaise / 100),
    offer: deal.offer ?? '',
    highlights: Array.isArray(deal.highlights) ? deal.highlights : [],
    shortLink: deal.shortLink ?? '',
    taggedUrl: deal.taggedUrl,
  };
}
