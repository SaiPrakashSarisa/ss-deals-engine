import { cookies } from 'next/headers';
import type { AdminDeal } from '../components/admin/types';
import { apiUrl, sessionCookieName } from './session';

export async function loadAdminDeal(
  id: string,
): Promise<{ ok: true; deal: AdminDeal } | { ok: false; missing: boolean }> {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (token === undefined || token.length === 0) {
    return { ok: false, missing: false };
  }
  try {
    const response = await fetch(`${apiUrl()}/api/admin/deals/${id}`, {
      headers: { cookie: `${sessionCookieName()}=${token}` },
      cache: 'no-store',
    });
    if (response.status === 404) {
      return { ok: false, missing: true };
    }
    if (!response.ok) {
      return { ok: false, missing: false };
    }
    return { ok: true, deal: (await response.json()) as AdminDeal };
  } catch {
    return { ok: false, missing: false };
  }
}
