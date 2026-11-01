import { describe, expect, it } from 'vitest';
import { normalizeUsername, parseUserAdminArgs } from '../../src/scripts/user-admin.js';

describe('user admin arguments', () => {
  it('reads the username and role and rejects a password flag', () => {
    expect(parseUserAdminArgs(['--username', 'ada', '--role', 'owner'])).toEqual({
      username: 'ada',
      role: 'owner',
      passwordOnCommandLine: false,
    });
    expect(parseUserAdminArgs(['--username=ada', '--password=secret']).passwordOnCommandLine).toBe(
      true,
    );
  });

  it('accepts a short login name and rejects a blank one', () => {
    expect(normalizeUsername(' clerk.1 ')).toBe('clerk.1');
    expect(() => normalizeUsername('')).toThrow(/Username/);
    expect(() => normalizeUsername('has space')).toThrow(/Username/);
  });
});
