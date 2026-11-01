import { redirect } from 'next/navigation';
import { getCurrentUser, homePath } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user === null) {
    redirect('/login');
  }
  redirect(homePath(user.role));
}
