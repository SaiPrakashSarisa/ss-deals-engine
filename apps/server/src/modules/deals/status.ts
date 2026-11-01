export const dealStatuses = [
  'draft',
  'pending_approval',
  'approved',
  'scheduled',
  'published',
  'rejected',
  'failed',
] as const;

export type DealStatus = (typeof dealStatuses)[number];

/** Legal moves in the clerk and owner review flow. Published is terminal. */
export const allowedTransitions: Record<DealStatus, readonly DealStatus[]> = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'rejected', 'draft'],
  approved: ['scheduled', 'published', 'rejected'],
  scheduled: ['published', 'failed', 'approved'],
  failed: ['approved', 'rejected'],
  rejected: ['pending_approval'],
  published: [],
};

export class DealStatusTransitionError extends Error {
  readonly from: DealStatus;
  readonly to: DealStatus;

  constructor(from: DealStatus, to: DealStatus) {
    super(`Illegal deal status transition from ${from} to ${to}`);
    this.name = 'DealStatusTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: DealStatus, to: DealStatus): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertTransition(from: DealStatus, to: DealStatus): void {
  if (!canTransition(from, to)) {
    throw new DealStatusTransitionError(from, to);
  }
}
