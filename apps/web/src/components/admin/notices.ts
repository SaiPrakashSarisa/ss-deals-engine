export function reviewExitHref(kind: 'sent_back' | 'rejected', name?: string): string {
  if (kind === 'rejected') {
    return '/admin?notice=rejected';
  }
  return `/admin?notice=sent_back&name=${encodeURIComponent(name ?? '')}`;
}

export function reviewExitMessage(notice: string | null, name: string | null): string | undefined {
  if (notice === 'rejected') {
    return 'Rejected.';
  }
  if (notice === 'sent_back') {
    const person = name?.trim() ?? '';
    return person.length > 0 ? `Sent back to ${person}.` : 'Sent back.';
  }
  return undefined;
}
