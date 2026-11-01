export function dealStatusLabel(status: string, reviewNote: string | null): string {
  const note = reviewNote?.trim() ?? '';
  if (status === 'draft' && note.length > 0) {
    return 'Sent back';
  }
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'pending_approval':
      return 'Waiting for review';
    case 'approved':
      return 'Approved';
    case 'scheduled':
      return 'Scheduled';
    case 'published':
      return 'Posted';
    case 'rejected':
      return 'Rejected';
    case 'failed':
      return 'Could not post';
    default:
      return 'Draft';
  }
}

export function dealFeedback(deal: {
  status: string;
  reviewNote: string | null;
  rejectedReason: string | null;
}): string | null {
  const review = deal.reviewNote?.trim() ?? '';
  const rejected = deal.rejectedReason?.trim() ?? '';
  if (deal.status === 'rejected') {
    return review || rejected || null;
  }
  if (deal.status === 'draft' && review.length > 0) {
    return review;
  }
  return null;
}
