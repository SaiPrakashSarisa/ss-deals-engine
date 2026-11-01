import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../lib/db.js';
import { sessions, users } from '../../db/schema/index.js';
import { cookieMaxAgeSeconds, nextExpiry, sessionIsActive } from './expiry.js';
import { verifyPassword } from './password.js';
import { hashSessionToken, newSessionToken } from './token.js';

const USER_AGENT_MAX = 512;

export type AuthRole = 'owner' | 'clerk';

export type AuthUser = {
  id: string;
  username: string;
  role: AuthRole;
};

export type OpenedSession = AuthUser & {
  token: string;
  createdAt: Date;
  expiresAt: Date;
  maxAgeSeconds: number;
};

type AuthDb = Database['db'];

export type SessionDeps = {
  db: AuthDb;
  now: () => Date;
};

export async function authenticate(
  deps: SessionDeps,
  username: string,
  password: string,
  userAgent: string | undefined,
): Promise<OpenedSession | undefined> {
  const [user] = await deps.db.select().from(users).where(eq(users.username, username)).limit(1);
  const passwordOk =
    user?.passwordHash !== undefined && user.passwordHash !== null
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, null);
  if (user === undefined || !user.isActive || !passwordOk) {
    return undefined;
  }

  const now = deps.now();
  const token = newSessionToken();
  const expiresAt = nextExpiry(now, now);
  await deps.db.insert(sessions).values({
    id: hashSessionToken(token),
    userId: user.id,
    createdAt: now,
    expiresAt,
    lastSeenAt: now,
    userAgent: clipUserAgent(userAgent),
  });

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    token,
    createdAt: now,
    expiresAt,
    maxAgeSeconds: cookieMaxAgeSeconds(now, now),
  };
}

export async function touchSession(
  deps: SessionDeps,
  token: string,
): Promise<(AuthUser & { createdAt: Date; maxAgeSeconds: number }) | undefined> {
  const now = deps.now();
  const [row] = await deps.db
    .select({
      sessionId: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      userId: users.id,
      username: users.username,
      role: users.role,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, hashSessionToken(token)))
    .limit(1);

  if (row === undefined || !row.isActive) {
    return undefined;
  }
  if (
    !sessionIsActive(
      { createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt },
      now,
    )
  ) {
    return undefined;
  }

  const expiresAt = nextExpiry(row.createdAt, now);
  await deps.db
    .update(sessions)
    .set({ lastSeenAt: now, expiresAt })
    .where(and(eq(sessions.id, row.sessionId), isNull(sessions.revokedAt)));

  return {
    id: row.userId,
    username: row.username,
    role: row.role,
    createdAt: row.createdAt,
    maxAgeSeconds: cookieMaxAgeSeconds(row.createdAt, now),
  };
}

export async function revokeSession(deps: SessionDeps, token: string): Promise<void> {
  await deps.db
    .update(sessions)
    .set({ revokedAt: deps.now() })
    .where(and(eq(sessions.id, hashSessionToken(token)), isNull(sessions.revokedAt)));
}

export async function revokeUserSessions(deps: SessionDeps, userId: string): Promise<void> {
  await deps.db
    .update(sessions)
    .set({ revokedAt: deps.now() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

function clipUserAgent(userAgent: string | undefined): string | undefined {
  if (userAgent === undefined) {
    return undefined;
  }
  const trimmed = userAgent.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, USER_AGENT_MAX);
}
