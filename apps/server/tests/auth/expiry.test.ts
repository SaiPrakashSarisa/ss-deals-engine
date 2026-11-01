import { describe, expect, it } from 'vitest';
import {
  ABSOLUTE_MS,
  IDLE_MS,
  cookieMaxAgeSeconds,
  nextExpiry,
  sessionIsActive,
} from '../../src/modules/auth/expiry.js';

const start = new Date('2026-11-01T00:00:00.000Z');

describe('session expiry', () => {
  it('starts an idle window and caps a slide at the absolute deadline', () => {
    expect(nextExpiry(start, start).getTime()).toBe(start.getTime() + IDLE_MS);

    const later = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    expect(nextExpiry(start, later).getTime()).toBe(later.getTime() + IDLE_MS);

    const nearEnd = new Date(start.getTime() + ABSOLUTE_MS - 60 * 60 * 1000);
    expect(nextExpiry(start, nearEnd).getTime()).toBe(start.getTime() + ABSOLUTE_MS);
  });

  it('treats idle expiry and the 7-day absolute deadline as closed', () => {
    const expiresAt = nextExpiry(start, start);
    expect(
      sessionIsActive(
        { createdAt: start, expiresAt, revokedAt: null },
        new Date(expiresAt.getTime() - 1),
      ),
    ).toBe(true);
    expect(sessionIsActive({ createdAt: start, expiresAt, revokedAt: null }, expiresAt)).toBe(
      false,
    );
    expect(
      sessionIsActive(
        { createdAt: start, expiresAt: new Date(start.getTime() + ABSOLUTE_MS), revokedAt: null },
        new Date(start.getTime() + ABSOLUTE_MS),
      ),
    ).toBe(false);
    expect(
      sessionIsActive(
        { createdAt: start, expiresAt, revokedAt: new Date(start.getTime() + 1000) },
        start,
      ),
    ).toBe(false);
  });

  it('sets the cookie lifetime to the remaining absolute window', () => {
    expect(cookieMaxAgeSeconds(start, start)).toBe(ABSOLUTE_MS / 1000);
    expect(cookieMaxAgeSeconds(start, new Date(start.getTime() + ABSOLUTE_MS))).toBe(0);
  });
});
