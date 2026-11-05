export const DRAFTS_PER_HOUR = 30;
export const UPLOADS_PER_HOUR = 30;
export const HOUR_MS = 60 * 60 * 1000;

export type WindowLimit = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export type WindowLimiter = {
  check(key: string, nowMs: number): WindowLimit;
};

export function createWindowLimiter(options: { limit: number; windowMs: number }): WindowLimiter {
  const hits = new Map<string, number[]>();

  return {
    check(key, nowMs) {
      const kept = (hits.get(key) ?? []).filter((stamp) => nowMs - stamp < options.windowMs);
      if (kept.length >= options.limit) {
        hits.set(key, kept);
        const oldest = kept[0] ?? nowMs;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((options.windowMs - (nowMs - oldest)) / 1000)),
        };
      }
      kept.push(nowMs);
      hits.set(key, kept);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}
