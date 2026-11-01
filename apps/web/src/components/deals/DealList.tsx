import { formatPaise } from '../../lib/money';
import { dealFeedback, dealStatusLabel } from './status-label';

export type ListedDeal = {
  id: string;
  title: string | null;
  status: string;
  pricePaise: number;
  reviewNote: string | null;
  rejectedReason: string | null;
};

export function DealList({ deals }: { deals: ListedDeal[] }) {
  if (deals.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-white p-6">
        <p className="text-xl">You have no deals yet.</p>
        <a
          href="/deals/new"
          className="mt-4 inline-flex min-h-14 items-center rounded-xl bg-primary px-5 text-lg font-semibold text-white"
        >
          New deal
        </a>
      </div>
    );
  }

  return (
    <ul className="grid gap-4">
      {deals.map((deal) => {
        const note = dealFeedback(deal);
        const label = dealStatusLabel(deal.status, deal.reviewNote);
        return (
          <li key={deal.id} className="rounded-2xl border border-line bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-2xl font-bold">{deal.title?.trim() || 'Untitled deal'}</h2>
              <span className="rounded-full bg-accent px-3 py-1 text-base font-semibold">
                {label}
              </span>
            </div>
            <p className="mt-2 text-xl">{formatPaise(deal.pricePaise)}</p>
            {note !== null ? <p className="mt-3 text-lg">{note}</p> : null}
            {deal.status === 'draft' ? (
              <a
                href={`/deals/new?id=${deal.id}`}
                className="mt-4 inline-flex min-h-12 items-center rounded-xl border-2 border-primary px-4 text-lg font-semibold text-primary"
              >
                Edit
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
