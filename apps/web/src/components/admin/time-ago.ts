export function timeAgo(iso: string | null, now: number): string {
  if (iso === null) {
    return 'just now';
  }
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return 'just now';
  }
  const minutes = Math.max(0, Math.floor((now - then) / 60000));
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
