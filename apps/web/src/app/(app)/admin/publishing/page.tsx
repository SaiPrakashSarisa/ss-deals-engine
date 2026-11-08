import { forbidden } from 'next/navigation';
import { PublishingDesk } from '../../../../components/admin/PublishingDesk';
import { getCurrentUser } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function PublishingPage() {
  const user = await getCurrentUser();
  if (user === null || user.role !== 'owner') {
    forbidden();
  }
  return <PublishingDesk />;
}
