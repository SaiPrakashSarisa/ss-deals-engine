import { cookies } from 'next/headers';
import { apiUrl, sessionCookieName } from './session';
import type { ListedDeal } from '../components/deals/DealList';

export async function loadMyDeals(): Promise<ListedDeal[] | null> {
  const jar = await cookies();
  const token = jar.get(sessionCookieName())?.value;
  if (token === undefined || token.length === 0) {
    return null;
  }
  try {
    const response = await fetch(`${apiUrl()}/api/deals`, {
      headers: { cookie: `${sessionCookieName()}=${token}` },
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { deals?: ListedDeal[] };
    return Array.isArray(body.deals) ? body.deals : [];
  } catch {
    return null;
  }
}
