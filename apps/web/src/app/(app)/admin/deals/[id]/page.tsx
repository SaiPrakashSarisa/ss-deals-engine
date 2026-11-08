import { forbidden } from 'next/navigation';
import { ReviewScreen } from '../../../../../components/admin/ReviewScreen';
import { loadAdminDeal } from '../../../../../lib/admin';
import { getCurrentUser } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function AdminDealPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (user === null || user.role !== 'owner') {
    forbidden();
  }
  const { id } = await params;
  const loaded = await loadAdminDeal(id);
  if (!loaded.ok) {
    return (
      <section className="rounded-2xl border border-line bg-white p-6">
        <h1 className="text-3xl font-bold">Review deal</h1>
        <p className="mt-4 text-xl">
          {loaded.missing ? 'That deal was not found.' : 'The deal could not be loaded. Try again.'}
        </p>
      </section>
    );
  }

  return <ReviewScreen initialDeal={loaded.deal} />;
}
