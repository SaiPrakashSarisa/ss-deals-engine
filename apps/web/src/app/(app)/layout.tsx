import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AppShell } from '../../components/AppShell';
import { getCurrentUser } from '../../lib/session';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (user === null) {
    redirect('/login');
  }

  return (
    <>
      <AppShell user={user} />
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </>
  );
}
