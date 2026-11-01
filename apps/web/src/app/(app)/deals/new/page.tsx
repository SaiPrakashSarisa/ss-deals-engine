import { DealForm } from '../../../../components/deals/DealForm';

export const dynamic = 'force-dynamic';

export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[] }>;
}) {
  const params = await searchParams;
  const dealId = typeof params.id === 'string' && params.id.length > 0 ? params.id : undefined;

  return (
    <section>
      <h1 className="mb-6 text-3xl font-bold">{dealId === undefined ? 'New deal' : 'Edit deal'}</h1>
      <DealForm dealId={dealId} />
    </section>
  );
}
