import { describe, expect, it } from 'vitest';
import { paiseToRupees, rupeesToPaise } from '../src/index.js';

describe('rupeesToPaise and paiseToRupees', () => {
  it('round-trips whole rupees through paise', () => {
    for (const rupees of [0, 1, 1499, 149999]) {
      expect(paiseToRupees(rupeesToPaise(rupees))).toBe(rupees);
      expect(rupeesToPaise(rupees)).toBe(rupees * 100);
    }
    for (const paise of [0, 100, 149900]) {
      expect(rupeesToPaise(paiseToRupees(paise))).toBe(paise);
    }
  });

  it('rejects non-integer or negative rupees', () => {
    expect(() => rupeesToPaise(1.5)).toThrow(TypeError);
    expect(() => rupeesToPaise(Number.NaN)).toThrow(TypeError);
    expect(() => rupeesToPaise(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => rupeesToPaise(-1)).toThrow(TypeError);
    expect(() => rupeesToPaise(-0)).toThrow(TypeError);
  });

  it('rejects non-integer or negative paise', () => {
    expect(() => paiseToRupees(1.5)).toThrow(TypeError);
    expect(() => paiseToRupees(Number.NaN)).toThrow(TypeError);
    expect(() => paiseToRupees(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => paiseToRupees(-1)).toThrow(TypeError);
    expect(() => paiseToRupees(-0)).toThrow(TypeError);
  });

  it('rejects paise that are not a whole number of rupees', () => {
    expect(() => paiseToRupees(1)).toThrow(RangeError);
    expect(() => paiseToRupees(50)).toThrow(RangeError);
  });

  it('rejects a rupee amount that cannot be stored as safe integer paise', () => {
    expect(() => rupeesToPaise(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});
