import {
  parseAmazonProductUrl,
  parsePriceInput,
  rupeesToPaise,
  validateShortLink,
} from '@ss-deals/core';
import { z } from 'zod';
import {
  FIELD_SUMMARY,
  HIGHLIGHT_COUNT_ERROR,
  HIGHLIGHT_LENGTH_ERROR,
  NOTES_LENGTH_ERROR,
  OFFER_LENGTH_ERROR,
  OLD_PRICE_ERROR,
  OLD_PRICE_ORDER_ERROR,
  PRICE_ERROR,
  PRICE_TOO_BIG_ERROR,
  SHORT_LINK_ERROR,
  SOURCE_NOTE_LENGTH_ERROR,
  TITLE_ERROR,
  TITLE_LENGTH_ERROR,
  URL_ERROR,
} from './messages.js';

const MAX_PAISE = 2_147_483_647;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fieldFallbacks: Record<string, string> = {
  productUrl: URL_ERROR,
  title: TITLE_ERROR,
  price: PRICE_ERROR,
  oldPrice: OLD_PRICE_ERROR,
  offer: OFFER_LENGTH_ERROR,
  highlights: HIGHLIGHT_COUNT_ERROR,
  shortLink: SHORT_LINK_ERROR,
  sourceNote: SOURCE_NOTE_LENGTH_ERROR,
  clerkNotes: NOTES_LENGTH_ERROR,
  url: URL_ERROR,
};

export type DealInput = {
  originalUrl: string;
  asin: string;
  taggedUrl: string;
  title: string;
  pricePaise: number;
  oldPricePaise: number | null;
  offer: string | null;
  highlights: string[];
  shortLink: string | null;
  sourceNote: string | null;
  clerkNotes: string | null;
  confirmUnknownPrice: boolean;
  previewEnabled: boolean | null;
};

export type FieldFailure = {
  ok: false;
  error: string;
  fields: Record<string, string>;
};

export type ReviewEditInput = {
  title: string;
  pricePaise: number;
  oldPricePaise: number | null;
  offer: string | null;
  highlights: string[];
  shortLink: string | null;
  sourceNote: string | null;
  previewEnabled: boolean;
  oldPriceVerified: boolean;
  updatedAt: Date;
};

export type ReviewEditParseResult = { ok: true; value: ReviewEditInput } | FieldFailure;

export type DealParseResult = { ok: true; value: DealInput } | FieldFailure;

export type CheckParseResult =
  | { ok: true; value: { url: string; pricePaise: number | null; dealId: string | null } }
  | FieldFailure;

function blankToUndefined(value: unknown): unknown {
  if (value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function asText(value: unknown): unknown {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return value;
}

const optionalText = (max: number, tooLong: string) =>
  z.preprocess(blankToUndefined, z.string({ error: tooLong }).max(max, tooLong).optional());

const dealSchema = z.object({
  productUrl: z
    .string({ error: URL_ERROR })
    .trim()
    .min(1, URL_ERROR)
    .max(2000, 'That product link is too long.'),
  title: z.string({ error: TITLE_ERROR }).trim().min(1, TITLE_ERROR).max(200, TITLE_LENGTH_ERROR),
  price: z.preprocess(asText, z.string({ error: PRICE_ERROR }).min(1, PRICE_ERROR)),
  oldPrice: z.preprocess(
    (value) => {
      if (value === undefined || value === null) {
        return undefined;
      }
      const text = asText(value);
      if (typeof text === 'string' && text.length === 0) {
        return undefined;
      }
      return text;
    },
    z.string({ error: OLD_PRICE_ERROR }).min(1, OLD_PRICE_ERROR).optional(),
  ),
  offer: optionalText(120, OFFER_LENGTH_ERROR),
  highlights: z.preprocess(
    (value) => {
      if (value === undefined) {
        return [];
      }
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return value;
      }
      return value.map((item) => item.trim()).filter((item) => item.length > 0);
    },
    z.array(z.string().max(80, HIGHLIGHT_LENGTH_ERROR)).max(3, HIGHLIGHT_COUNT_ERROR),
  ),
  shortLink: optionalText(500, SHORT_LINK_ERROR),
  sourceNote: optionalText(120, SOURCE_NOTE_LENGTH_ERROR),
  clerkNotes: optionalText(300, NOTES_LENGTH_ERROR),
  confirmUnknownPrice: z.boolean().optional(),
  previewEnabled: z.boolean().optional(),
});

const reviewEditSchema = dealSchema
  .pick({
    title: true,
    price: true,
    oldPrice: true,
    offer: true,
    highlights: true,
    shortLink: true,
    sourceNote: true,
  })
  .extend({
    previewEnabled: z.boolean({ error: 'Choose whether the link preview is on.' }),
    oldPriceVerified: z.boolean({ error: 'Choose whether the old price is verified.' }),
    updatedAt: z
      .string({ error: 'Send the latest version of this deal.' })
      .min(1, 'Send the latest version of this deal.'),
  });

const checkSchema = z.object({
  url: z
    .string({ error: URL_ERROR })
    .trim()
    .min(1, URL_ERROR)
    .max(2000, 'That product link is too long.'),
  price: z.preprocess(asText, z.string().optional()),
  dealId: z.preprocess((value) => {
    if (typeof value !== 'string' || value.trim() === '') {
      return undefined;
    }
    return value.trim();
  }, z.string().regex(UUID_PATTERN, 'That deal was not found.').optional()),
});

function fieldMap(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = typeof issue.path[0] === 'string' ? issue.path[0] : 'form';
    if (fields[key] !== undefined) {
      continue;
    }
    const fallback = fieldFallbacks[key];
    fields[key] =
      issue.message.startsWith('Invalid input') || issue.message.startsWith('Too small')
        ? (fallback ?? 'Check this field.')
        : issue.message;
  }
  return fields;
}

function toPaise(rupees: number): number | undefined {
  try {
    const paise = rupeesToPaise(rupees);
    if (paise <= 0 || paise > MAX_PAISE) {
      return undefined;
    }
    return paise;
  } catch {
    return undefined;
  }
}

export function parseDealBody(
  body: unknown,
  options: { amazonTag: string; shortLinkHosts: readonly string[] },
): DealParseResult {
  const parsed = dealSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: FIELD_SUMMARY, fields: fieldMap(parsed.error) };
  }

  const fields: Record<string, string> = {};
  const link = parseAmazonProductUrl(parsed.data.productUrl, options.amazonTag);
  if (!link.ok) {
    fields.productUrl = link.message;
  }

  const rupees = parsePriceInput(parsed.data.price);
  const pricePaise = rupees === undefined ? undefined : toPaise(rupees);
  if (rupees === undefined) {
    fields.price = PRICE_ERROR;
  } else if (pricePaise === undefined) {
    fields.price = PRICE_TOO_BIG_ERROR;
  }

  let oldPricePaise: number | null = null;
  if (parsed.data.oldPrice !== undefined) {
    const oldRupees = parsePriceInput(parsed.data.oldPrice);
    if (oldRupees === undefined) {
      fields.oldPrice = OLD_PRICE_ERROR;
    } else if (rupees !== undefined && oldRupees <= rupees) {
      fields.oldPrice = OLD_PRICE_ORDER_ERROR;
    } else {
      const converted = toPaise(oldRupees);
      if (converted === undefined) {
        fields.oldPrice = PRICE_TOO_BIG_ERROR;
      } else {
        oldPricePaise = converted;
      }
    }
  }

  let shortLink: string | null = null;
  if (parsed.data.shortLink !== undefined) {
    const short = validateShortLink(parsed.data.shortLink, options.shortLinkHosts);
    if (!short.ok) {
      fields.shortLink = SHORT_LINK_ERROR;
    } else {
      shortLink = short.url;
    }
  }

  if (!link.ok || pricePaise === undefined || Object.keys(fields).length > 0) {
    return { ok: false, error: FIELD_SUMMARY, fields };
  }

  return {
    ok: true,
    value: {
      originalUrl: parsed.data.productUrl,
      asin: link.asin,
      taggedUrl: link.url,
      title: parsed.data.title,
      pricePaise,
      oldPricePaise,
      offer: parsed.data.offer ?? null,
      highlights: parsed.data.highlights,
      shortLink,
      sourceNote: parsed.data.sourceNote ?? null,
      clerkNotes: parsed.data.clerkNotes ?? null,
      confirmUnknownPrice: parsed.data.confirmUnknownPrice === true,
      previewEnabled: parsed.data.previewEnabled ?? null,
    },
  };
}

export function parseReviewEdit(
  body: unknown,
  options: { shortLinkHosts: readonly string[] },
): ReviewEditParseResult {
  const parsed = reviewEditSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: FIELD_SUMMARY, fields: fieldMap(parsed.error) };
  }

  const fields: Record<string, string> = {};
  const rupees = parsePriceInput(parsed.data.price);
  const pricePaise = rupees === undefined ? undefined : toPaise(rupees);
  if (rupees === undefined) {
    fields.price = PRICE_ERROR;
  } else if (pricePaise === undefined) {
    fields.price = PRICE_TOO_BIG_ERROR;
  }

  let oldPricePaise: number | null = null;
  if (parsed.data.oldPrice !== undefined) {
    const oldRupees = parsePriceInput(parsed.data.oldPrice);
    if (oldRupees === undefined) {
      fields.oldPrice = OLD_PRICE_ERROR;
    } else if (rupees !== undefined && oldRupees <= rupees) {
      fields.oldPrice = OLD_PRICE_ORDER_ERROR;
    } else {
      const converted = toPaise(oldRupees);
      if (converted === undefined) {
        fields.oldPrice = PRICE_TOO_BIG_ERROR;
      } else {
        oldPricePaise = converted;
      }
    }
  }

  let shortLink: string | null = null;
  if (parsed.data.shortLink !== undefined) {
    const short = validateShortLink(parsed.data.shortLink, options.shortLinkHosts);
    if (!short.ok) {
      fields.shortLink = SHORT_LINK_ERROR;
    } else {
      shortLink = short.url;
    }
  }

  const updatedAt = new Date(parsed.data.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) {
    fields.updatedAt = 'Send the latest version of this deal.';
  }

  if (pricePaise === undefined || Object.keys(fields).length > 0) {
    return { ok: false, error: FIELD_SUMMARY, fields };
  }

  const oldPriceVerified = oldPricePaise !== null && parsed.data.oldPriceVerified;

  return {
    ok: true,
    value: {
      title: parsed.data.title,
      pricePaise,
      oldPricePaise,
      offer: parsed.data.offer ?? null,
      highlights: parsed.data.highlights,
      shortLink,
      sourceNote: parsed.data.sourceNote ?? null,
      previewEnabled: parsed.data.previewEnabled,
      oldPriceVerified,
      updatedAt,
    },
  };
}

export function parseCheckBody(body: unknown): CheckParseResult {
  const parsed = checkSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: FIELD_SUMMARY, fields: fieldMap(parsed.error) };
  }
  let pricePaise: number | null = null;
  if (parsed.data.price !== undefined && parsed.data.price.length > 0) {
    const rupees = parsePriceInput(parsed.data.price);
    pricePaise = rupees === undefined ? null : (toPaise(rupees) ?? null);
  }
  return {
    ok: true,
    value: {
      url: parsed.data.url,
      pricePaise,
      dealId: parsed.data.dealId ?? null,
    },
  };
}

export function parseStatusFilter(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = z
    .enum(['draft', 'pending_approval', 'approved', 'scheduled', 'published', 'rejected', 'failed'])
    .safeParse(value);
  return parsed.success ? parsed.data : 'invalid';
}

export function parseDealId(value: unknown): string | undefined {
  const parsed = z.string().regex(UUID_PATTERN).safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
