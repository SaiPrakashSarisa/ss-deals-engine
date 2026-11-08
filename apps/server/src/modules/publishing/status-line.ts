const RETRY_MARKER = /^retry:([^|]+)\|attempt:(\d+)\|(.*)$/;

export function retryLastError(at: Date, nextAttempt: number, reason: string): string {
  return `retry:${at.toISOString()}|attempt:${nextAttempt}|${reason}`;
}

export function parseRetry(
  lastError: string | null,
): { at: Date; attempt: number; reason: string } | null {
  if (lastError === null) {
    return null;
  }
  const match = RETRY_MARKER.exec(lastError);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  const at = new Date(match[1]);
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  return { at, attempt: Number(match[2]), reason: match[3] ?? '' };
}

export function formatIstClock(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '';
  const period = (parts.find((part) => part.type === 'dayPeriod')?.value ?? '').toLowerCase();
  return `${hour}:${minute} ${period}`;
}

export function formatIstWhen(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${read('weekday')} ${read('day')} ${read('month')}, ${read('hour')}:${read('minute')} ${read('dayPeriod').toLowerCase()}`;
}

export function movedFromMessage(original: Date): string {
  return `Moved from ${formatIstClock(original)} because the daily limit was full`;
}

export function movedMarker(original: Date): string {
  return `moved:${original.toISOString()}`;
}

export function gapStatusLine(earliest: Date): string {
  return `Waiting for the minimum gap (earliest ${formatIstClock(earliest)})`;
}

export function retryStatusLine(at: Date, attempt: number): string {
  return `Retrying at ${formatIstClock(at)} (attempt ${attempt} of 3)`;
}

export function publicationStatusLine(input: {
  status: string;
  lastError: string | null;
  attempts?: number;
  scheduledFor: Date | null;
  gapEnds: Date | null;
  now: Date;
}): string | null {
  const moved = movedStatus(input.lastError);
  if (input.status !== 'queued') {
    return moved;
  }
  const retry = parseRetry(input.lastError);
  if (retry !== null && retry.at.getTime() > input.now.getTime()) {
    return retryStatusLine(retry.at, retry.attempt);
  }
  if (moved !== null) {
    return moved;
  }
  if (input.lastError === "Waiting for tomorrow's limit") {
    return input.lastError;
  }
  if (
    input.gapEnds !== null &&
    input.scheduledFor !== null &&
    input.gapEnds.getTime() > input.now.getTime() &&
    input.gapEnds.getTime() > input.scheduledFor.getTime()
  ) {
    return gapStatusLine(input.gapEnds);
  }
  return null;
}

function movedStatus(lastError: string | null): string | null {
  if (lastError === null) {
    return null;
  }
  if (lastError.startsWith('Moved from ')) {
    return lastError;
  }
  if (!lastError.startsWith('moved:')) {
    return null;
  }
  const at = new Date(lastError.slice('moved:'.length));
  if (Number.isNaN(at.getTime())) {
    return null;
  }
  return movedFromMessage(at);
}
