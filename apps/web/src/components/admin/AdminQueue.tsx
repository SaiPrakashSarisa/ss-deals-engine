'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatPaise } from '../../lib/money';
import { timeAgo } from './time-ago';
import type { AdminListItem } from './types';

const filters = [
  { status: 'pending_approval', label: 'Waiting for review' },
  { status: 'approved', label: 'Approved' },
  { status: 'sent_back', label: 'Sent back' },
  { status: 'published', label: 'Posted' },
  { status: 'rejected', label: 'Rejected' },
  { status: 'scheduled', label: 'Scheduled' },
  { status: 'failed', label: 'Could not post' },
] as const;

function queueStatus(requested: string | null, fallback: string): string {
  const value = requested !== null && requested.length > 0 ? requested : fallback;
  return value === 'draft' ? 'sent_back' : value;
}

const summary = filters.slice(0, 5);

type QueueBody = {
  counts?: Record<string, number>;
  items?: AdminListItem[];
};

export function AdminQueue({ status, now = Date.now() }: { status: string; now?: number }) {
  const requested = useSearchParams().get('status');
  const active = queueStatus(requested, status);
  const [state, setState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [items, setItems] = useState<AdminListItem[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    void (async () => {
      try {
        const response = await fetch(`/api/admin/deals?status=${encodeURIComponent(active)}`);
        const body = (await response.json().catch(() => null)) as QueueBody | null;
        if (cancelled) {
          return;
        }
        if (!response.ok || body === null || !Array.isArray(body.items)) {
          setState('error');
          return;
        }
        setCounts(body.counts ?? {});
        setItems(body.items);
        setState('ready');
      } catch {
        if (!cancelled) {
          setState('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, reloadKey]);

  return (
    <section>
      <h1 className="text-3xl font-bold">Review queue</h1>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {summary.map((card) => (
          <a
            key={card.status}
            href={`/admin?status=${card.status}`}
            aria-current={card.status === active ? 'page' : undefined}
            className={`rounded-2xl border-2 bg-white p-4 ${
              card.status === active ? 'border-primary' : 'border-line'
            }`}
          >
            <p className="text-base font-semibold">{card.label}</p>
            <p className="mt-2 text-3xl font-bold">{counts[card.status] ?? 0}</p>
          </a>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Deal status">
        {filters.map((filter) => (
          <a
            key={filter.status}
            href={`/admin?status=${filter.status}`}
            role="tab"
            aria-selected={filter.status === active}
            className={`inline-flex min-h-12 items-center rounded-xl px-4 text-lg font-semibold ${
              filter.status === active
                ? 'bg-primary text-white'
                : 'border-2 border-primary text-primary'
            }`}
          >
            {filter.label}
          </a>
        ))}
      </div>
      {state === 'loading' ? <p className="mt-6 text-xl">Loading…</p> : null}
      {state === 'error' ? (
        <div className="mt-6 rounded-2xl border border-line bg-white p-6">
          <p className="text-xl">The review queue could not be loaded.</p>
          <button
            type="button"
            className="mt-4 inline-flex min-h-14 items-center rounded-xl bg-primary px-5 text-lg font-semibold text-white"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      ) : null}
      {state === 'ready' && items.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-line bg-white p-6 text-xl">
          No deals in this list.
        </p>
      ) : null}
      {state === 'ready' && items.length > 0 ? (
        <ul className="mt-6 grid gap-4">
          {items.map((deal) => (
            <li key={deal.id} className="rounded-2xl border border-line bg-white p-4">
              <div className="flex flex-col gap-4 sm:flex-row">
                {deal.hasImage ? (
                  <img
                    src={`/api/deals/${deal.id}/image`}
                    alt=""
                    className="h-28 w-full rounded-xl object-cover sm:w-28"
                  />
                ) : (
                  <div className="flex h-28 w-full items-center justify-center rounded-xl border-2 border-dashed border-line text-lg sm:w-28">
                    No image
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="text-2xl font-bold">{deal.title}</h2>
                  <p className="mt-1 text-xl">
                    {formatPaise(deal.price * 100)}
                    {deal.oldPrice !== null ? (
                      <span className="ml-2 text-lg text-slate-700 line-through">
                        {formatPaise(deal.oldPrice * 100)}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 text-lg">{deal.createdBy}</p>
                  <p className="text-lg">{timeAgo(deal.submittedAt, now)}</p>
                  {deal.sourceNote !== null && deal.sourceNote.trim() !== '' ? (
                    <p className="mt-1 text-lg">{deal.sourceNote}</p>
                  ) : null}
                </div>
                <a
                  href={`/admin/deals/${deal.id}`}
                  className="inline-flex min-h-14 items-center justify-center rounded-xl bg-primary px-6 text-xl font-semibold text-white"
                >
                  {deal.status === 'published' ? 'View' : 'Review'}
                </a>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
