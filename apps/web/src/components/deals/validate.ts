import { parsePriceInput, validateShortLink } from '@ss-deals/core';

export type DealFormValues = {
  title: string;
  price: string;
  oldPrice: string;
  offer: string;
  highlights: string[];
  shortLink: string;
  sourceNote: string;
  notes: string;
};

export function validateDealForm(
  values: DealFormValues,
  shortLinkHosts: readonly string[] | null,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const title = values.title.trim();
  if (title.length === 0) {
    fields.title = 'Enter a title.';
  } else if (title.length > 200) {
    fields.title = 'Keep the title under 200 characters.';
  }

  const rupees = parsePriceInput(values.price);
  if (rupees === undefined) {
    fields.price = 'Enter the price in whole rupees.';
  }

  if (values.oldPrice.trim() !== '') {
    const oldRupees = parsePriceInput(values.oldPrice);
    if (oldRupees === undefined) {
      fields.oldPrice = 'Enter the old price in whole rupees.';
    } else if (rupees !== undefined && oldRupees <= rupees) {
      fields.oldPrice = 'Old price has to be higher than the price.';
    }
  }

  if (values.offer.trim().length > 120) {
    fields.offer = 'Keep the offer under 120 characters.';
  }

  const highlights = values.highlights.map((item) => item.trim()).filter((item) => item.length > 0);
  if (highlights.length > 3) {
    fields.highlights = 'Enter up to 3 highlights.';
  } else if (highlights.some((item) => item.length > 80)) {
    fields.highlights = 'Keep each highlight under 80 characters.';
  }

  const shortLink = values.shortLink.trim();
  if (
    shortLink.length > 0 &&
    shortLinkHosts !== null &&
    !validateShortLink(shortLink, shortLinkHosts).ok
  ) {
    fields.shortLink = 'Paste an https short link, or leave this empty.';
  }
  if (values.sourceNote.trim().length > 120) {
    fields.sourceNote = 'Keep this under 120 characters.';
  }
  if (values.notes.trim().length > 300) {
    fields.clerkNotes = 'Keep notes under 300 characters.';
  }
  return fields;
}
