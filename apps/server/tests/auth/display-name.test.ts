import { describe, expect, it } from 'vitest';
import { visibleName } from '../../src/modules/auth/service.js';

describe('visible name', () => {
  it('uses the saved name and falls back to the username', () => {
    expect(visibleName('Ada Lovelace', 'ada')).toBe('Ada Lovelace');
    expect(visibleName(null, 'ada')).toBe('ada');
    expect(visibleName('   ', 'ada')).toBe('ada');
    expect(visibleName(undefined, 'ada')).toBe('ada');
  });
});
