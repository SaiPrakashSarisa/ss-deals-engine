'use client';

import { useEffect, useState } from 'react';
import { formatPaise } from '../../lib/money';
import { follow } from '../../lib/navigate';
import { Modal } from './Modal';
import { formatDealPreview, previewFieldsFromStored } from './preview';
import { dealFeedback, dealStatusLabel } from './status-label';

export type ListedDeal = {
  id: string;
  title: string | null;
  status: string;
  pricePaise: number;
  oldPricePaise: number | null;
  highlights: string[];
  offer: string | null;
  shortLink: string | null;
  taggedUrl: string | null;
  productUrl: string;
  reviewNote: string | null;
  rejectedReason: string | null;
  hasImage: boolean;
};

type Overlay = { kind: 'preview' | 'withdraw'; deal: ListedDeal } | null;

const primaryButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl bg-primary px-5 text-lg font-semibold text-white';
const secondaryButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl border-2 border-primary px-5 text-lg font-semibold text-primary';

export function DealList({
  deals,
  shortLinkHosts,
}: {
  deals: ListedDeal[];
  shortLinkHosts?: readonly string[];
}) {
  const [items, setItems] = useState(deals);
  const [hosts, setHosts] = useState<readonly string[] | null>(shortLinkHosts ?? null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [withdrawError, setWithdrawError] = useState<string | undefined>();
  const [withdrawing, setWithdrawing] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setItems(deals);
  }, [deals]);

  useEffect(() => {
    if (shortLinkHosts !== undefined) {
      setHosts(shortLinkHosts);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/deals/config');
        const body = (await response.json().catch(() => null)) as {
          shortLinkHosts?: unknown;
        } | null;
        if (cancelled || !response.ok || body === null || !Array.isArray(body.shortLinkHosts)) {
          return;
        }
        setHosts(body.shortLinkHosts.filter((host) => typeof host === 'string'));
      } catch {
        if (!cancelled) {
          setHosts([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shortLinkHosts]);

  function openPreview(deal: ListedDeal): void {
    setImageFailed(false);
    setWithdrawError(undefined);
    setOverlay({ kind: 'preview', deal });
  }

  function askWithdraw(deal: ListedDeal): void {
    setWithdrawError(undefined);
    setOverlay({ kind: 'withdraw', deal });
  }

  function closeOverlay(): void {
    setOverlay(null);
    setWithdrawError(undefined);
    setWithdrawing(false);
  }

  async function refreshList(): Promise<void> {
    try {
      const response = await fetch('/api/deals');
      const body = (await response.json().catch(() => null)) as { deals?: ListedDeal[] } | null;
      if (response.ok && body !== null && Array.isArray(body.deals)) {
        setItems(body.deals);
      }
    } catch {
      // Keep the list that is already on screen.
    }
  }

  async function withdrawAndEdit(deal: ListedDeal): Promise<void> {
    setWithdrawing(true);
    setWithdrawError(undefined);
    try {
      const response = await fetch(`/api/deals/${deal.id}/withdraw`, { method: 'POST' });
      if (response.status === 409) {
        setWithdrawError('This deal was already reviewed.');
        await refreshList();
        return;
      }
      if (!response.ok) {
        setWithdrawError('This deal could not be withdrawn. Try again.');
        return;
      }
      follow(`/deals/${deal.id}/edit`);
    } catch {
      setWithdrawError('This deal could not be withdrawn. Try again.');
    } finally {
      setWithdrawing(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded-2xl border border-line bg-white p-6">
        <p className="text-xl">You have no deals yet.</p>
        <a href="/deals/new" className={`mt-4 ${primaryButton}`}>
          New deal
        </a>
      </div>
    );
  }

  const preview =
    overlay?.kind === 'preview'
      ? formatDealPreview(previewFieldsFromStored(overlay.deal), hosts)
      : undefined;
  const reviewNote = overlay?.deal.reviewNote?.trim() ?? '';

  return (
    <>
      <ul className="grid gap-4">
        {items.map((deal) => {
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
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" onClick={() => openPreview(deal)} className={primaryButton}>
                  Preview
                </button>
                <EditControl deal={deal} onWithdraw={() => askWithdraw(deal)} />
              </div>
            </li>
          );
        })}
      </ul>
      {overlay?.kind === 'preview' ? (
        <Modal titleId="deal-preview-title" onClose={closeOverlay}>
          <h2 id="deal-preview-title" className="text-2xl font-bold">
            {overlay.deal.title?.trim() || 'Untitled deal'}
          </h2>
          {overlay.deal.hasImage && !imageFailed ? (
            <img
              src={`/api/deals/${overlay.deal.id}/image`}
              alt={overlay.deal.title?.trim() || 'Deal image'}
              className="max-h-64 rounded-xl"
              onError={() => setImageFailed(true)}
            />
          ) : (
            <div className="flex min-h-40 items-center justify-center rounded-xl border-2 border-dashed border-line text-lg">
              No image
            </div>
          )}
          {preview === undefined ? (
            <p className="mt-4 text-lg">The post preview is not available.</p>
          ) : preview.ok ? (
            <div
              className="mt-4 whitespace-pre-wrap text-lg"
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          ) : (
            <p className="mt-4 text-lg">{preview.message}</p>
          )}
          <p className="mt-3 text-base text-slate-700">Preview - the admin may change it</p>
          <p className="mt-3">
            <span className="rounded-full bg-accent px-3 py-1 text-base font-semibold">
              {dealStatusLabel(overlay.deal.status, overlay.deal.reviewNote)}
            </span>
          </p>
          {reviewNote.length > 0 ? <p className="mt-3 text-lg">{reviewNote}</p> : null}
          <div className="mt-5 flex flex-wrap gap-3">
            <EditControl deal={overlay.deal} onWithdraw={() => askWithdraw(overlay.deal)} />
            <button type="button" onClick={closeOverlay} className={secondaryButton}>
              Close
            </button>
          </div>
        </Modal>
      ) : null}
      {overlay?.kind === 'withdraw' ? (
        <Modal titleId="withdraw-title" onClose={closeOverlay}>
          <h2 id="withdraw-title" className="text-2xl font-bold">
            Edit this deal
          </h2>
          {withdrawError !== undefined ? (
            <p role="alert" className="mt-3 text-lg">
              {withdrawError}
            </p>
          ) : (
            <p className="mt-3 text-lg">
              This deal will leave the review queue. You can send it again after editing.
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            {withdrawError === undefined ? (
              <button
                type="button"
                disabled={withdrawing}
                onClick={() => void withdrawAndEdit(overlay.deal)}
                className={primaryButton}
              >
                {withdrawing ? 'Withdrawing…' : 'Withdraw and edit'}
              </button>
            ) : null}
            <button type="button" onClick={closeOverlay} className={secondaryButton}>
              {withdrawError === undefined ? 'Cancel' : 'Close'}
            </button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function EditControl({ deal, onWithdraw }: { deal: ListedDeal; onWithdraw: () => void }) {
  if (deal.status === 'draft') {
    return (
      <a href={`/deals/${deal.id}/edit`} className={secondaryButton}>
        Edit
      </a>
    );
  }
  if (deal.status === 'pending_approval') {
    return (
      <button type="button" onClick={onWithdraw} className={secondaryButton}>
        Edit
      </button>
    );
  }
  return null;
}
