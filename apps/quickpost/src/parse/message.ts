import { parseAmazonProductUrl } from '../amazon/url.js';
import { DEFAULT_SHORT_LINK_HOSTS } from '../config/env.js';
import type { DealDraft } from '../deal.js';

export type ParseResult = { ok: true; draft: DealDraft } | { ok: false; errors: string[] };

export type ParseOptions = {
  shortLinkHosts?: readonly string[];
};

const FIELD_PATTERN = /^(title|price|old|verified|offer|short|preview)\s*:\s*(.*)$/i;
const FIELD_LINE = /^(title|price|old|verified|offer|short|preview)\s*:/i;
const MAX_OFFER_LENGTH = 120;

export function parseDealMessage(
  text: string,
  tag: string,
  options: ParseOptions = {},
): ParseResult {
  const errors: string[] = [];
  const hosts = options.shortLinkHosts ?? DEFAULT_SHORT_LINK_HOSTS;
  const link = readProductLink(text, tag);
  const fields = readFields(text);

  if (link.kind === 'error') {
    errors.push(link.message);
  }
  if (fields.title === undefined || fields.title.length === 0) {
    errors.push('Add a title: line.');
  }
  const price = readPrice(fields.priceRaw, errors);
  const oldPrice = readOldPrice(fields.oldRaw, price, errors);
  const verified = readVerified(fields.verifiedRaw, errors);
  const offer = readOffer(fields.offerRaw, errors);
  const shortUrl = readShort(fields.shortRaw, hosts, errors);
  const linkPreview = readPreview(fields.previewRaw, errors);

  if (errors.length > 0 || link.kind !== 'ok' || price === undefined) {
    return { ok: false, errors };
  }

  const draft: DealDraft = {
    asin: link.asin,
    taggedUrl: link.url,
    title: fields.title ?? '',
    price,
    verified,
    highlights: fields.highlights,
  };
  if (oldPrice !== undefined) {
    draft.oldPrice = oldPrice;
  }
  if (offer !== undefined) {
    draft.offer = offer;
  }
  if (shortUrl !== undefined) {
    draft.shortUrl = shortUrl;
  }
  if (linkPreview === false) {
    draft.linkPreview = false;
  }
  return { ok: true, draft };
}

export function parseRupeeAmount(raw: string): number | undefined {
  let text = raw.trim();
  if (text.startsWith('₹')) {
    text = text.slice(1).trim();
  }
  text = text.replaceAll(',', '');
  if (!/^[1-9]\d{0,11}$/.test(text)) {
    return undefined;
  }
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return undefined;
  }
  return amount;
}

export function firstHttpUrl(text: string): string | undefined {
  const match = /https?:\/\/[^\s<>"']+/i.exec(text);
  const raw = match?.[0];
  if (raw === undefined) {
    return undefined;
  }
  return raw.replace(/[),.;\]]+$/u, '');
}

export function shortLinkError(hosts: readonly string[]): string {
  return `The short: line must be an https link on an allowed host (${hosts.join(', ')}).`;
}

function readProductLink(
  text: string,
  tag: string,
): { kind: 'ok'; asin: string; url: string } | { kind: 'error'; message: string } {
  const rawUrl = firstHttpUrl(textWithoutFieldLines(text));
  if (rawUrl === undefined) {
    return { kind: 'error', message: 'Paste the full amazon.in product link.' };
  }
  const parsed = parseAmazonProductUrl(rawUrl, tag);
  if (!parsed.ok) {
    return { kind: 'error', message: parsed.message };
  }
  return { kind: 'ok', asin: parsed.asin, url: parsed.url };
}

function textWithoutFieldLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !FIELD_LINE.test(line.trim()))
    .join('\n');
}

function readFields(text: string): {
  title?: string;
  priceRaw?: string;
  oldRaw?: string;
  verifiedRaw?: string;
  offerRaw?: string;
  shortRaw?: string;
  previewRaw?: string;
  highlights: string[];
} {
  let title: string | undefined;
  let priceRaw: string | undefined;
  let oldRaw: string | undefined;
  let verifiedRaw: string | undefined;
  let offerRaw: string | undefined;
  let shortRaw: string | undefined;
  let previewRaw: string | undefined;
  const highlights: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('-')) {
      const highlight = trimmed.slice(1).trim();
      if (highlight.length > 0) {
        highlights.push(highlight);
      }
      continue;
    }

    const field = FIELD_PATTERN.exec(trimmed);
    const key = field?.[1]?.toLowerCase();
    const value = field?.[2]?.trim();
    if (key === undefined || value === undefined) {
      continue;
    }
    if (key === 'title') {
      title = value;
    } else if (key === 'price') {
      priceRaw = value;
    } else if (key === 'old') {
      oldRaw = value;
    } else if (key === 'verified') {
      verifiedRaw = value;
    } else if (key === 'offer') {
      offerRaw = value;
    } else if (key === 'short') {
      shortRaw = value;
    } else if (key === 'preview') {
      previewRaw = value;
    }
  }

  return { title, priceRaw, oldRaw, verifiedRaw, offerRaw, shortRaw, previewRaw, highlights };
}

function readPrice(priceRaw: string | undefined, errors: string[]): number | undefined {
  if (priceRaw === undefined) {
    errors.push('Add a price: line.');
    return undefined;
  }
  const price = parseRupeeAmount(priceRaw);
  if (price === undefined) {
    errors.push('Price must be a positive whole number of rupees, such as 1499 or ₹1,499.');
    return undefined;
  }
  return price;
}

function readOldPrice(
  oldRaw: string | undefined,
  price: number | undefined,
  errors: string[],
): number | undefined {
  if (oldRaw === undefined) {
    return undefined;
  }
  const oldPrice = parseRupeeAmount(oldRaw);
  if (oldPrice === undefined) {
    errors.push('Old price must be a positive whole number of rupees.');
    return undefined;
  }
  if (price !== undefined && oldPrice <= price) {
    errors.push('Old price must be greater than the current price.');
  }
  return oldPrice;
}

function readVerified(verifiedRaw: string | undefined, errors: string[]): boolean {
  if (verifiedRaw === undefined) {
    return false;
  }
  const value = verifiedRaw.toLowerCase();
  if (value === 'yes') {
    return true;
  }
  if (value === 'no') {
    return false;
  }
  errors.push('Verified must be yes or no.');
  return false;
}

function readOffer(offerRaw: string | undefined, errors: string[]): string | undefined {
  if (offerRaw === undefined || offerRaw.length === 0) {
    return undefined;
  }
  if (offerRaw.length > MAX_OFFER_LENGTH) {
    errors.push('Offer must be 120 characters or fewer.');
    return undefined;
  }
  return offerRaw;
}

function readShort(
  shortRaw: string | undefined,
  hosts: readonly string[],
  errors: string[],
): string | undefined {
  if (shortRaw === undefined) {
    return undefined;
  }
  const message = shortLinkError(hosts);
  let parsed: URL;
  try {
    parsed = new URL(shortRaw);
  } catch {
    errors.push(message);
    return undefined;
  }
  const allowed = new Set(hosts.map((host) => host.toLowerCase()));
  if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname)) {
    errors.push(message);
    return undefined;
  }
  return shortRaw;
}

function readPreview(previewRaw: string | undefined, errors: string[]): boolean {
  if (previewRaw === undefined) {
    return true;
  }
  const value = previewRaw.toLowerCase();
  if (value === 'on') {
    return true;
  }
  if (value === 'off') {
    return false;
  }
  errors.push('Preview must be on or off.');
  return true;
}
