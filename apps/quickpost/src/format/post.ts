export const AMAZON_BUTTON_LABEL = '🛒 Check deal on Amazon';
export const MAX_CAPTION_LENGTH = 900;
export const FORBIDDEN_PHRASES = [
  'hurry',
  'last chance',
  'loot',
  'lowest ever',
  'limited time',
] as const;

export type LinkStyle = 'text' | 'button' | 'both';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export type FormatInput = {
  title: string;
  price: number;
  oldPrice?: number;
  verified: boolean;
  highlights: string[];
  offer?: string;
  linkUrl: string;
  linkStyle: LinkStyle;
  footer?: string;
};

export type FormatResult =
  | {
      ok: true;
      html: string;
      urlButton?: { text: string; url: string };
      warnings: string[];
    }
  | { ok: false; message: string };

export function formatPost(input: FormatInput): FormatResult {
  const blocks = [`🔥 <b>${escapeHtml(input.title)}</b>`, priceBlock(input)];

  const highlights = input.highlights.slice(0, 3).map((highlight) => `✨ ${escapeHtml(highlight)}`);
  if (highlights.length > 0) {
    blocks.push(highlights.join('\n'));
  }

  if (input.linkStyle !== 'button') {
    blocks.push(`🛒 Buy Here : ${escapeHtml(input.linkUrl)}`);
  }

  if (input.footer !== undefined && input.footer.length > 0) {
    blocks.push(`<i>${escapeHtml(input.footer)}</i>`);
  }

  const html = blocks.join('\n\n');
  if (html.length >= MAX_CAPTION_LENGTH) {
    return {
      ok: false,
      message: `This post is ${html.length} characters. Keep the caption under ${MAX_CAPTION_LENGTH} characters.`,
    };
  }

  const warnings = collectWarnings(input);
  if (input.linkStyle === 'text') {
    return { ok: true, html, warnings };
  }
  return {
    ok: true,
    html,
    urlButton: { text: AMAZON_BUTTON_LABEL, url: input.linkUrl },
    warnings,
  };
}

function priceBlock(input: FormatInput): string {
  const lines: string[] = [];
  let priceLine = `🎁 <b>Deal Price : ₹${formatRupees(input.price)}</b>`;
  if (input.oldPrice !== undefined && input.verified) {
    priceLine += `  <s>₹${formatRupees(input.oldPrice)}</s>`;
    lines.push(priceLine, `🟢 <b>${discountPercent(input.price, input.oldPrice)}% off</b>`);
  } else {
    lines.push(priceLine);
    if (input.oldPrice !== undefined) {
      lines.push(`Listed at ₹${formatRupees(input.oldPrice)}`);
    }
  }
  if (input.offer !== undefined && input.offer.length > 0) {
    lines.push(`💳 Offer: ${escapeHtml(input.offer)}`);
  }
  return lines.join('\n');
}

export function formatRupees(amount: number): string {
  return inr.format(amount);
}

export function discountPercent(price: number, oldPrice: number): number {
  return Math.round(((oldPrice - price) / oldPrice) * 100);
}

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function findForbiddenPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN_PHRASES.filter((phrase) => lower.includes(phrase));
}

function collectWarnings(input: FormatInput): string[] {
  const warnings: string[] = [];
  const found = findForbiddenPhrases([input.title, ...input.highlights].join('\n'));
  if (found.length > 0) {
    warnings.push(`The title or highlights include: ${found.join(', ')}.`);
  }
  if (input.highlights.length > 3) {
    warnings.push('Only the first 3 highlights are included.');
  }
  return warnings;
}
