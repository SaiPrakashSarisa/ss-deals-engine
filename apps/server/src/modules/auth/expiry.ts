export const IDLE_MS = 12 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionTimes = {
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export function absoluteDeadline(createdAt: Date): Date {
  return new Date(createdAt.getTime() + ABSOLUTE_MS);
}

export function nextExpiry(createdAt: Date, now: Date): Date {
  const idle = now.getTime() + IDLE_MS;
  const absolute = createdAt.getTime() + ABSOLUTE_MS;
  return new Date(Math.min(idle, absolute));
}

export function sessionIsActive(session: SessionTimes, now: Date): boolean {
  if (session.revokedAt !== null) {
    return false;
  }
  if (now.getTime() >= session.createdAt.getTime() + ABSOLUTE_MS) {
    return false;
  }
  return now.getTime() < session.expiresAt.getTime();
}

export function cookieMaxAgeSeconds(createdAt: Date, now: Date): number {
  const remainingMs = createdAt.getTime() + ABSOLUTE_MS - now.getTime();
  if (remainingMs <= 0) {
    return 0;
  }
  return Math.floor(remainingMs / 1000);
}
