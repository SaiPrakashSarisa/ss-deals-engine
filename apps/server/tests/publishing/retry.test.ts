import { describe, expect, it } from 'vitest';
import { retryDelayMs } from '../../src/modules/publishing/retry.js';

describe('retryDelayMs', () => {
  it('waits 1 minute then 5 minutes and stops on the third attempt', () => {
    expect(retryDelayMs(1, { kind: 'not_sent', reason: 'refused' })).toBe(60_000);
    expect(retryDelayMs(2, { kind: 'not_sent', reason: 'refused' })).toBe(5 * 60_000);
    expect(retryDelayMs(3, { kind: 'not_sent', reason: 'refused' })).toBeUndefined();
  });

  it('uses retry_after for a rate limit and never retries uncertain', () => {
    expect(retryDelayMs(1, { kind: 'rate_limited', retryAfterSeconds: 45 })).toBe(45_000);
    expect(retryDelayMs(3, { kind: 'rate_limited', retryAfterSeconds: 45 })).toBeUndefined();
    expect(retryDelayMs(1, { kind: 'uncertain', reason: 'timeout' })).toBeUndefined();
    expect(retryDelayMs(1, { kind: 'rejected', reason: 'nope' })).toBeUndefined();
  });
});
