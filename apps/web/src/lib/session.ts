import { cookies } from 'next/headers';

export type SessionUser = {
  id: string;
  username: string;
  role: 'owner' | 'clerk';
};

export function apiUrl(): string {
  const value = process.env.API_URL?.trim();
  const base = value === undefined || value.length === 0 ? 'http://127.0.0.1:3000' : value;
  return base.replace(/\/$/, '');
}

export function sessionCookieName(): string {
  const name = process.env.SESSION_COOKIE_NAME?.trim();
  return name === undefined || name.length === 0 ? 'ssd_session' : name;
}

export function homePath(role: SessionUser['role']): '/owner' | '/clerk' {
  return role === 'owner' ? '/owner' : '/clerk';
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (token === undefined || token.length === 0) {
    return null;
  }

  const response = await fetch(`${apiUrl()}/api/auth/me`, {
    headers: { cookie: `${sessionCookieName()}=${token}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as Partial<SessionUser>;
  if (
    typeof body.id !== 'string' ||
    typeof body.username !== 'string' ||
    (body.role !== 'owner' && body.role !== 'clerk')
  ) {
    return null;
  }
  return { id: body.id, username: body.username, role: body.role };
}
