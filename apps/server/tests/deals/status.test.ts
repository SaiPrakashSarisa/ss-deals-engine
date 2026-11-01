import { describe, expect, it } from 'vitest';
import {
  DealStatusTransitionError,
  allowedTransitions,
  assertTransition,
  canTransition,
  dealStatuses,
  type DealStatus,
} from '../../src/modules/deals/status.js';

const allowedPairs = new Set(
  dealStatuses.flatMap((from) => allowedTransitions[from].map((to) => `${from}->${to}`)),
);

describe('deal status transitions', () => {
  it('allows every transition in the map and rejects every other pair', () => {
    const allowed: string[] = [];
    const illegal: string[] = [];

    for (const from of dealStatuses) {
      for (const to of dealStatuses) {
        const pair = `${from}->${to}`;
        if (allowedPairs.has(pair)) {
          allowed.push(pair);
          expect(canTransition(from, to)).toBe(true);
          expect(() => {
            assertTransition(from, to);
          }).not.toThrow();
        } else {
          illegal.push(pair);
          expect(canTransition(from, to)).toBe(false);
          expect(() => {
            assertTransition(from, to);
          }).toThrow(DealStatusTransitionError);
        }
      }
    }

    expect(allowed).toEqual([
      'draft->pending_approval',
      'pending_approval->draft',
      'pending_approval->approved',
      'pending_approval->rejected',
      'approved->scheduled',
      'approved->published',
      'approved->rejected',
      'scheduled->approved',
      'scheduled->published',
      'scheduled->failed',
      'rejected->pending_approval',
      'failed->approved',
      'failed->rejected',
    ]);
    expect(illegal).toHaveLength(dealStatuses.length * dealStatuses.length - allowed.length);
    expect(illegal).toContain('published->draft');
    expect(illegal).toContain('published->published');
    expect(illegal).toContain('draft->approved');
    expect(illegal).toContain('draft->draft');
  });

  it('names the illegal statuses in the error', () => {
    let caught: unknown;
    try {
      assertTransition('published', 'approved');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DealStatusTransitionError);
    const error = caught as DealStatusTransitionError;
    expect(error.from).toBe('published');
    expect(error.to).toBe('approved');
    expect(error.message).toBe('Illegal deal status transition from published to approved');
  });

  it('treats published as terminal', () => {
    const targets: DealStatus[] = [...dealStatuses];
    for (const to of targets) {
      expect(canTransition('published', to)).toBe(false);
    }
  });
});
