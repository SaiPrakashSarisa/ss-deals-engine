import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hashPassword,
  passwordPolicyError,
  verifyPassword,
} from '../../src/modules/auth/password.js';

describe('password hashing', () => {
  it('verifies the original password and rejects a different one', async () => {
    const password = 'correct-horse-battery';
    const stored = await hashPassword(password);

    expect(stored).not.toContain(password);
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword('wrong-password-value', stored)).toBe(false);
    expect(await verifyPassword(password, null)).toBe(false);
    expect(await verifyPassword(password, 'not-a-hash')).toBe(false);
  });

  it('uses a fresh salt for each hash', async () => {
    const password = 'correct-horse-battery';
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).not.toBe(second);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(password, second)).toBe(true);
  });

  it('enforces the password length used by the user script', () => {
    expect(passwordPolicyError('short-pass')).toMatch(/at least 12/);
    expect(passwordPolicyError('x'.repeat(PASSWORD_MIN_LENGTH))).toBeUndefined();
    expect(passwordPolicyError('x'.repeat(PASSWORD_MAX_LENGTH))).toBeUndefined();
    expect(passwordPolicyError('x'.repeat(PASSWORD_MAX_LENGTH + 1))).toMatch(/at most 1024/);
  });
});
