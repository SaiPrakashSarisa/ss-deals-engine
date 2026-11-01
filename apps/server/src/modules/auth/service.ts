import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../lib/db.js';
import { sessions, users } from '../../db/schema/index.js';
import { cookieMaxAgeSeconds, nextExpiry, sessionIsActive } from './expiry.js';
import { hashPassword, passwordPolicyError, verifyPassword } from './password.js';
import { hashSessionToken, newSessionToken } from './token.js';

const USER_AGENT_MAX = 512;

export type AuthRole = 'owner' | 'clerk';

export type AuthUser = {
  id: string;
  username: string;
  role: AuthRole;
  displayName: string;
};

export type PasswordChangeFailure = 'wrong' | 'policy' | 'same';

export function visibleName(displayName: string | null | undefined, username: string): string {
  const trimmed = displayName?.trim() ?? '';
  return trimmed.length === 0 ? username : trimmed;
}

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
    displayName: visibleName(user.displayName, user.username),
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
      displayName: users.displayName,
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
    displayName: visibleName(row.displayName, row.username),
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

export async function changePassword(
  deps: SessionDeps,
  userId: string,
  currentToken: string,
  currentPassword: string,
  newPassword: string,
): Promise<PasswordChangeFailure | undefined> {
  const [user] = await deps.db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const stored = user?.passwordHash ?? null;
  const passwordOk = await verifyPassword(currentPassword, stored);
  if (user === undefined || stored === null || !passwordOk) {
    return 'wrong';
  }

  if (passwordPolicyError(newPassword) !== undefined) {
    return 'policy';
  }
  if (currentPassword === newPassword || (await verifyPassword(newPassword, stored))) {
    return 'same';
  }

  const now = deps.now();
  const passwordHash = await hashPassword(newPassword);
  const currentSessionId = hashSessionToken(currentToken);
  await deps.db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          ne(sessions.id, currentSessionId),
        ),
      );
  });
  return undefined;
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
