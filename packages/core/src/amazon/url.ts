const AMAZON_IN_HOSTS = new Set(['amazon.in', 'www.amazon.in', 'm.amazon.in']);

const SHORT_LINK_HOSTS = new Set(['amzn.to', 'amzn.asia', 'amzn.eu', 'amzn.in', 'a.co']);

export const SHORT_LINK_MESSAGE = 'Please paste the full amazon.in product link';

const OTHER_DOMAIN_MESSAGE = 'Only amazon.in product links are accepted.';
const INVALID_ASIN_MESSAGE = 'The product link does not contain a valid 10-character ASIN.';
const NOT_PRODUCT_MESSAGE = 'Use an amazon.in /dp/ or /gp/product/ link.';

export type AmazonLink = { ok: true; asin: string; url: string } | { ok: false; message: string };

type AsinMatch = { status: 'found'; asin: string } | { status: 'invalid' } | { status: 'missing' };

export function parseAmazonProductUrl(raw: string, tag: string): AmazonLink {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: OTHER_DOMAIN_MESSAGE };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: OTHER_DOMAIN_MESSAGE };
  }

  const hostKind = classifyHost(parsed.hostname);
  if (hostKind === 'short') {
    return { ok: false, message: SHORT_LINK_MESSAGE };
  }
  if (hostKind !== 'amazon') {
    return { ok: false, message: OTHER_DOMAIN_MESSAGE };
  }

  const asin = matchAsin(parsed.pathname);
  if (asin.status === 'invalid') {
    return { ok: false, message: INVALID_ASIN_MESSAGE };
  }
  if (asin.status === 'missing') {
    return { ok: false, message: NOT_PRODUCT_MESSAGE };
  }

  return { ok: true, asin: asin.asin, url: buildTaggedProductUrl(asin.asin, tag) };
}

export function buildTaggedProductUrl(asin: string, tag: string): string {
  const url = new URL(`https://www.amazon.in/dp/${asin}`);
  url.searchParams.set('tag', tag);
  return url.toString();
}

export const buildTaggedUrl = buildTaggedProductUrl;

export type ShortLinkResult = { ok: true; url: string } | { ok: false };

export function validateShortLink(raw: string, hosts: readonly string[]): ShortLinkResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false };
  }
  const allowed = new Set(hosts.map((host) => host.toLowerCase()));
  if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname)) {
    return { ok: false };
  }
  return { ok: true, url: raw };
}

function classifyHost(hostname: string): 'amazon' | 'short' | 'other' {
  const host = hostname.toLowerCase();
  if (AMAZON_IN_HOSTS.has(host)) {
    return 'amazon';
  }
  if (SHORT_LINK_HOSTS.has(host)) {
    return 'short';
  }
  if (host.startsWith('www.') && SHORT_LINK_HOSTS.has(host.slice(4))) {
    return 'short';
  }
  return 'other';
}

function matchAsin(pathname: string): AsinMatch {
  const parts = pathname
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => safeDecode(part));

  for (let index = 0; index < parts.length; index += 1) {
    const current = parts[index];
    if (current === undefined) {
      continue;
    }
    const marker = current.toLowerCase();
    const previous = index > 0 ? parts[index - 1]?.toLowerCase() : undefined;
    const isProduct = marker === 'dp' || (marker === 'product' && previous === 'gp');
    if (!isProduct) {
      continue;
    }
    const next = parts[index + 1];
    if (next !== undefined && /^[A-Za-z0-9]{10}$/.test(next)) {
      return { status: 'found', asin: next.toUpperCase() };
    }
    return { status: 'invalid' };
  }

  return { status: 'missing' };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
