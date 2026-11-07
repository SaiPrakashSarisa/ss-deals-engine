import { forbidden } from 'next/navigation';
import { AdminQueue } from '../../../components/admin/AdminQueue';
import { getCurrentUser } from '../../../lib/session';

export const dynamic = 'force-dynamic';

const known = new Set([
  'pending_approval',
  'approved',
  'draft',
  'rejected',
  'published',
  'failed',
  'scheduled',
]);

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await getCurrentUser();
  if (user === null || user.role !== 'owner') {
    forbidden();
  }
  const query = await searchParams;
  const status =
    query.status !== undefined && known.has(query.status) ? query.status : 'pending_approval';

  return <AdminQueue status={status} />;
}
