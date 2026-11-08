import type { TelegramResult } from './telegram.js';

/** Waits after a connection failure. Attempt 3 is the last send, so 15 minutes is not scheduled. */
export const CONNECTION_RETRY_MINUTES = [1, 5, 15] as const;
export const MAX_PUBLISH_ATTEMPTS = 3;

export type TelegramRetry = Extract<TelegramResult, { kind: 'rate_limited' | 'not_sent' }>;

export function retryDelayMs(attempts: number, result: TelegramResult): number | undefined {
  if (result.kind !== 'rate_limited' && result.kind !== 'not_sent') {
    return undefined;
  }
  if (attempts >= MAX_PUBLISH_ATTEMPTS) {
    return undefined;
  }
  if (result.kind === 'rate_limited') {
    return Math.max(1, result.retryAfterSeconds) * 1000;
  }
  const minutes = CONNECTION_RETRY_MINUTES[attempts - 1];
  return minutes === undefined ? undefined : minutes * 60_000;
}
