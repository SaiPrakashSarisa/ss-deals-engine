import { DealList } from '../../../../components/deals/DealList';
import { loadDealConfig, loadMyDeals } from '../../../../lib/deals';

export const dynamic = 'force-dynamic';

export default async function MyDealsPage() {
  const deals = await loadMyDeals();
  const shortLinkHosts = deals === null ? null : await loadDealConfig();

  return (
    <section>
      <h1 className="mb-6 text-3xl font-bold">My deals</h1>
      {deals === null ? (
        <p className="text-xl">Your deals could not be loaded. Try again.</p>
      ) : (
        <DealList deals={deals} shortLinkHosts={shortLinkHosts ?? undefined} />
      )}
    </section>
  );
}
