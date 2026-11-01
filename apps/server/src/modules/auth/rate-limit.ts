export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const USERNAME_IP_FAILURE_LIMIT = 5;
export const IP_FAILURE_LIMIT = 20;

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export type RateLimiter = {
  check(username: string, ip: string, nowMs: number): RateLimitDecision;
  recordFailure(username: string, ip: string, nowMs: number): void;
  clearUsername(username: string, ip: string): void;
};

export function createRateLimiter(
  options: {
    windowMs?: number;
    usernameIpLimit?: number;
    ipLimit?: number;
  } = {},
): RateLimiter {
  const windowMs = options.windowMs ?? RATE_LIMIT_WINDOW_MS;
  const usernameIpLimit = options.usernameIpLimit ?? USERNAME_IP_FAILURE_LIMIT;
  const ipLimit = options.ipLimit ?? IP_FAILURE_LIMIT;
  const failures = new Map<string, number[]>();

  function prune(key: string, nowMs: number): number[] {
    const kept = (failures.get(key) ?? []).filter((stamp) => nowMs - stamp < windowMs);
    failures.set(key, kept);
    return kept;
  }

  function retryAfter(stamps: number[], nowMs: number): number {
    const oldest = stamps[0];
    if (oldest === undefined) {
      return 1;
    }
    return Math.max(1, Math.ceil((windowMs - (nowMs - oldest)) / 1000));
  }

  return {
    check(username, ip, nowMs) {
      const byPair = prune(pairKey(username, ip), nowMs);
      const byIp = prune(ipKey(ip), nowMs);
      if (byPair.length >= usernameIpLimit || byIp.length >= ipLimit) {
        const pairRetry = byPair.length >= usernameIpLimit ? retryAfter(byPair, nowMs) : 0;
        const ipRetry = byIp.length >= ipLimit ? retryAfter(byIp, nowMs) : 0;
        return { allowed: false, retryAfterSeconds: Math.max(pairRetry, ipRetry, 1) };
      }
      return { allowed: true, retryAfterSeconds: 0 };
    },
    recordFailure(username, ip, nowMs) {
      const pair = prune(pairKey(username, ip), nowMs);
      const ipStamps = prune(ipKey(ip), nowMs);
      pair.push(nowMs);
      ipStamps.push(nowMs);
      failures.set(pairKey(username, ip), pair);
      failures.set(ipKey(ip), ipStamps);
    },
    clearUsername(username, ip) {
      failures.delete(pairKey(username, ip));
    },
  };
}

function pairKey(username: string, ip: string): string {
  return `user:${username}\n${ip}`;
}

function ipKey(ip: string): string {
  return `ip:${ip}`;
}
