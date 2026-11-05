import { DealForm } from '../../../../../components/deals/DealForm';

export const dynamic = 'force-dynamic';

export default async function EditDealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <section>
      <DealForm mode="edit" dealId={id} />
    </section>
  );
}
