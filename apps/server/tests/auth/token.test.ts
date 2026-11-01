import { describe, expect, it } from 'vitest';
import { hashSessionToken, newSessionToken } from '../../src/modules/auth/token.js';

describe('session tokens', () => {
  it('creates a 32-byte token and stores only its sha-256 hash', () => {
    const token = newSessionToken();
    const again = newSessionToken();

    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).not.toBe(again);

    const hash = hashSessionToken(token);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSessionToken(token)).toBe(hash);
    expect(hashSessionToken(again)).not.toBe(hash);
  });
});
