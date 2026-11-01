import { describe, expect, it } from 'vitest';
import { createWindowLimiter } from '../../src/modules/deals/rate-limit.js';

describe('createWindowLimiter', () => {
  it('allows a fixed number of hits per window and then waits', () => {
    const limiter = createWindowLimiter({ limit: 2, windowMs: 1_000 });
    expect(limiter.check('user-1', 0).allowed).toBe(true);
    expect(limiter.check('user-1', 10).allowed).toBe(true);
    const blocked = limiter.check('user-1', 20);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(limiter.check('user-2', 20).allowed).toBe(true);
    expect(limiter.check('user-1', 1_001).allowed).toBe(true);
  });
});
