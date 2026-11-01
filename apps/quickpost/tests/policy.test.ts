import { describe, expect, it } from 'vitest';
import { DUPLICATE_WINDOW_MS, countPostsOnDay, findRecentDuplicate } from '../src/store/policy.js';
import type { PostedEntry } from '../src/store/posted.js';

const asin = 'B0CABCDEFG';
const now = Date.parse('2026-10-31T12:00:00.000Z');

function entry(offsetMs: number, messageId: PostedEntry['message_id'] = 1): PostedEntry {
  return {
    asin,
    timestamp: new Date(now - offsetMs).toISOString(),
    message_id: messageId,
  };
}

describe('duplicate window', () => {
  it('matches an ASIN posted exactly 14 days ago, including uncertain posts', () => {
    expect(
      findRecentDuplicate([entry(DUPLICATE_WINDOW_MS)], asin, now, DUPLICATE_WINDOW_MS)?.message_id,
    ).toBe(1);
    expect(
      findRecentDuplicate([entry(60_000, 'uncertain')], asin, now, DUPLICATE_WINDOW_MS)?.message_id,
    ).toBe('uncertain');
  });

  it('ignores an ASIN posted more than 14 days ago', () => {
    expect(
      findRecentDuplicate([entry(DUPLICATE_WINDOW_MS + 1)], asin, now, DUPLICATE_WINDOW_MS),
    ).toBeUndefined();
  });
});

describe('daily limit calendar', () => {
  it('counts posts on the Asia/Kolkata calendar day, including uncertain ones', () => {
    const evening = Date.parse('2026-10-31T19:00:00.000Z');
    const entries: PostedEntry[] = [
      {
        asin: 'B0TEST0001',
        timestamp: '2026-10-31T18:29:00.000Z',
        message_id: 1,
      },
      {
        asin: 'B0TEST0002',
        timestamp: '2026-10-31T18:30:00.000Z',
        message_id: 'uncertain',
      },
    ];

    expect(countPostsOnDay(entries, evening, 'Asia/Kolkata')).toBe(1);
    expect(countPostsOnDay(entries, Date.parse('2026-10-31T18:00:00.000Z'), 'Asia/Kolkata')).toBe(
      1,
    );
  });
});
