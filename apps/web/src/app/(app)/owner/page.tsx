import { forbidden } from 'next/navigation';
import { getCurrentUser } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function OwnerPage() {
  const user = await getCurrentUser();
  if (user === null || user.role !== 'owner') {
    forbidden();
  }

  return (
    <section className="rounded-2xl border border-line bg-white p-6">
      <h1 className="text-3xl font-bold">Review queue</h1>
      <p className="mt-4 text-xl">Review queue coming in T6.</p>
    </section>
  );
}
