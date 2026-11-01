import { describe, expect, it } from 'vitest';
import {
  IP_FAILURE_LIMIT,
  RATE_LIMIT_WINDOW_MS,
  USERNAME_IP_FAILURE_LIMIT,
  createRateLimiter,
} from '../../src/modules/auth/rate-limit.js';

const now = 1_700_000_000_000;

describe('login rate limit', () => {
  it('blocks a username and IP after five failures inside 15 minutes', () => {
    const limiter = createRateLimiter();
    for (let attempt = 0; attempt < USERNAME_IP_FAILURE_LIMIT; attempt += 1) {
      expect(limiter.check('clerk', '203.0.113.8', now).allowed).toBe(true);
      limiter.recordFailure('clerk', '203.0.113.8', now);
    }

    const blocked = limiter.check('clerk', '203.0.113.8', now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.check('owner', '203.0.113.8', now).allowed).toBe(true);
    expect(limiter.check('clerk', '203.0.113.9', now).allowed).toBe(true);
  });

  it('forgets failures once the window has passed and after a successful sign-in', () => {
    const limiter = createRateLimiter();
    limiter.recordFailure('clerk', '203.0.113.8', now);
    expect(limiter.check('clerk', '203.0.113.8', now + RATE_LIMIT_WINDOW_MS).allowed).toBe(true);

    limiter.recordFailure('clerk', '203.0.113.8', now);
    limiter.clearUsername('clerk', '203.0.113.8');
    expect(limiter.check('clerk', '203.0.113.8', now).allowed).toBe(true);
  });

  it('applies a separate per-IP cap across usernames', () => {
    const limiter = createRateLimiter();
    for (let attempt = 0; attempt < IP_FAILURE_LIMIT; attempt += 1) {
      const username = `user-${attempt}`;
      expect(limiter.check(username, '203.0.113.8', now).allowed).toBe(true);
      limiter.recordFailure(username, '203.0.113.8', now);
    }

    expect(limiter.check('someone-else', '203.0.113.8', now).allowed).toBe(false);
    expect(limiter.check('someone-else', '198.51.100.4', now).allowed).toBe(true);
  });
});
