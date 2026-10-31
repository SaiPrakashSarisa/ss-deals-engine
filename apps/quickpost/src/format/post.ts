export const AMAZON_BUTTON_LABEL = '🛒 Check deal on Amazon';
export const MAX_CAPTION_LENGTH = 900;
export const FORBIDDEN_PHRASES = [
  'hurry',
  'last chance',
  'loot',
  'lowest ever',
  'limited time',
] as const;

const TITLE_EMOJI = '🛍️';
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export type FormatInput = {
  title: string;
  price: number;
  oldPrice?: number;
  verified: boolean;
  highlights: string[];
  taggedUrl: string;
};

export type FormatResult =
  | {
      ok: true;
      html: string;
      urlButton: { text: string; url: string };
      warnings: string[];
    }
  | { ok: false; message: string };

export function formatPost(input: FormatInput): FormatResult {
  const sections = [
    `<b>${TITLE_EMOJI} ${escapeHtml(input.title)}</b>`,
    `<b>₹${formatRupees(input.price)} when posted (may change)</b>`,
  ];

  if (input.oldPrice !== undefined && input.verified) {
    const percent = discountPercent(input.price, input.oldPrice);
    sections.push(`<s>₹${formatRupees(input.oldPrice)}</s> ${percent}% lower`);
  } else if (input.oldPrice !== undefined) {
    sections.push(`Listed at ₹${formatRupees(input.oldPrice)}`);
  }

  const bullets = input.highlights.slice(0, 3).map((highlight) => `• ${escapeHtml(highlight)}`);
  if (bullets.length > 0) {
    sections.push(bullets.join('\n'));
  }

  sections.push(
    [
      '<i>Affiliate link: I may earn a commission at no extra cost to you.</i>',
      '<i>As an Amazon Associate I earn from qualifying purchases.</i>',
    ].join('\n'),
  );

  const html = sections.join('\n\n');
  if (html.length >= MAX_CAPTION_LENGTH) {
    return {
      ok: false,
      message: `This post is ${html.length} characters. Keep the caption under ${MAX_CAPTION_LENGTH} characters.`,
    };
  }

  return {
    ok: true,
    html,
    urlButton: { text: AMAZON_BUTTON_LABEL, url: input.taggedUrl },
    warnings: collectWarnings(input),
  };
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
