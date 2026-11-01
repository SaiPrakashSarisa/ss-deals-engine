import { describe, expect, it } from 'vitest';
import {
  normalizeDisplayName,
  normalizeUsername,
  parseUserAdminArgs,
} from '../../src/scripts/user-admin.js';

describe('user admin arguments', () => {
  it('reads the username and role and rejects a password flag', () => {
    expect(parseUserAdminArgs(['--username', 'ada', '--role', 'owner'])).toEqual({
      username: 'ada',
      role: 'owner',
      name: undefined,
      nameProvided: false,
      passwordOnCommandLine: false,
    });
    expect(parseUserAdminArgs(['--username', 'ada', '--name', 'Ada Lovelace'])).toMatchObject({
      name: 'Ada Lovelace',
      nameProvided: true,
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

  it('trims a display name and rejects a blank or oversized one', () => {
    expect(normalizeDisplayName('  Ada Lovelace  ')).toBe('Ada Lovelace');
    expect(() => normalizeDisplayName('   ')).toThrow(/blank/);
    expect(() => normalizeDisplayName('a'.repeat(61))).toThrow(/60/);
  });
});
