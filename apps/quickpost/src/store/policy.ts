import type { PostedEntry } from './posted.js';

export const DUPLICATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function findRecentDuplicate(
  entries: readonly PostedEntry[],
  asin: string,
  nowMs: number,
  windowMs: number,
): PostedEntry | undefined {
  let match: PostedEntry | undefined;
  let matchTimestamp = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (entry.asin !== asin) {
      continue;
    }
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    if (nowMs - timestamp > windowMs) {
      continue;
    }
    if (timestamp >= matchTimestamp) {
      match = entry;
      matchTimestamp = timestamp;
    }
  }

  return match;
}

export function countPostsOnDay(
  entries: readonly PostedEntry[],
  nowMs: number,
  timeZone: string,
): number {
  const today = calendarDay(nowMs, timeZone);
  let count = 0;
  for (const entry of entries) {
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    if (calendarDay(timestamp, timeZone) === today) {
      count += 1;
    }
  }
  return count;
}

export function calendarDay(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochMs));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Cannot format a calendar day for time zone ${timeZone}`);
  }
  return `${year}-${month}-${day}`;
}
