export const STALE_DEAL = 'This deal changed. Reload to see the latest version.';
export const WITHDRAWN_DEAL = 'This deal was withdrawn or changed.';
export const NOTE_REQUIRED = 'Enter a note for the person.';
export const REASON_REQUIRED = 'Enter a reason.';
export const REVIEW_TEXT_LENGTH = 'Keep this under 300 characters.';

export function readReviewText(
  value: unknown,
  emptyMessage: string,
): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: emptyMessage };
  }
  const text = value.trim();
  if (text.length > 300) {
    return { ok: false, error: REVIEW_TEXT_LENGTH };
  }
  return { ok: true, text };
}
