import type { SendOutcome } from './types.js';

export type Sleep = (ms: number) => Promise<void>;

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

export async function sendWithSingleRetry(
  attempt: () => Promise<SendOutcome>,
  sleep: Sleep,
): Promise<SendOutcome> {
  const first = await attempt();
  if (first.ok || first.reason !== 'rate_limited') {
    return first;
  }
  await sleep(Math.max(0, first.retryAfterSeconds) * 1000);
  return attempt();
}
