'use client';

import { parsePriceInput } from '@ss-deals/core';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { dealImageSrc } from '../deal-image';
import { validateDealForm } from '../deals/validate';
import { Modal } from '../deals/Modal';
import { reviewExitHref } from './notices';
import { PublishingControls } from './PublishingControls';
import { STALE_DEAL, type AdminDeal } from './types';

const fieldClass =
  'min-h-14 w-full rounded-xl border-2 border-slate-400 bg-white px-4 text-lg text-ink disabled:bg-slate-100';
const primaryButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl bg-primary px-5 text-lg font-semibold text-white disabled:opacity-60';
const secondaryButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl border-2 border-primary px-5 text-lg font-semibold text-primary disabled:opacity-60';
const dangerButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl bg-red-700 px-5 text-lg font-semibold text-white disabled:opacity-60';

type Fields = {
  title: string;
  price: string;
  oldPrice: string;
  offer: string;
  highlights: [string, string, string];
  shortLink: string;
  sourceNote: string;
  previewEnabled: boolean;
  verified: boolean;
};

function fieldsFrom(deal: AdminDeal): Fields {
  return {
    title: deal.title,
    price: String(deal.price),
    oldPrice: deal.oldPrice === null ? '' : String(deal.oldPrice),
    offer: deal.offer ?? '',
    highlights: [deal.highlights[0] ?? '', deal.highlights[1] ?? '', deal.highlights[2] ?? ''],
    shortLink: deal.shortLink ?? '',
    sourceNote: deal.sourceNote ?? '',
    previewEnabled: deal.previewEnabled,
    verified: deal.oldPriceVerified,
  };
}

function snapshot(fields: Fields): string {
  return JSON.stringify(fields);
}

function canVerifyPrice(price: string, oldPrice: string): boolean {
  const amount = parsePriceInput(price);
  const oldAmount = oldPrice.trim() === '' ? undefined : parsePriceInput(oldPrice);
  return amount !== undefined && oldAmount !== undefined && oldAmount > amount;
}

function repostBanner(reason: string, allowed: boolean): string | undefined {
  if (allowed && reason === 'first_post') {
    return 'This product has not been posted before.';
  }
  if (allowed && reason === 'price_lower') {
    return 'This price is lower than the last posted price.';
  }
  if (reason === 'previous_price_unknown') {
    return 'This product was posted before, but the earlier price is missing.';
  }
  if (!allowed) {
    return 'This product was already posted. The new price has to be lower than the last posted price.';
  }
  return undefined;
}

async function readError(
  response: Response,
): Promise<{ error?: string; fields?: Record<string, string> }> {
  return (await response.json().catch(() => ({}))) as {
    error?: string;
    fields?: Record<string, string>;
  };
}

export function ReviewScreen({ initialDeal }: { initialDeal: AdminDeal }) {
  const router = useRouter();
  const busy = useRef(false);
  const [deal, setDeal] = useState(initialDeal);
  const [fields, setFields] = useState<Fields>(() => fieldsFrom(initialDeal));
  const [saved, setSaved] = useState(() => snapshot(fieldsFrom(initialDeal)));
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [pending, setPending] = useState<string | undefined>();
  const [modal, setModal] = useState<'back' | 'reject' | undefined>();
  const [modalText, setModalText] = useState('');
  const [modalError, setModalError] = useState<string | undefined>();
  const [imageFailed, setImageFailed] = useState(false);

  const editable = deal.status === 'pending_approval' || deal.status === 'approved';
  const canVerify = canVerifyPrice(fields.price, fields.oldPrice);
  const dirty = snapshot(fields) !== saved;

  useEffect(() => {
    setDeal(initialDeal);
    const next = fieldsFrom(initialDeal);
    setFields(next);
    setSaved(snapshot(next));
  }, [initialDeal]);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
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
  }, []);

  const banner = useMemo(
    () => repostBanner(deal.duplicate.repost.reason, deal.duplicate.repost.allowed),
    [deal.duplicate.repost.allowed, deal.duplicate.repost.reason],
  );

  function patchFields(next: Partial<Fields>): void {
    setFields((current) => {
      const merged = { ...current, ...next };
      if (!canVerifyPrice(merged.price, merged.oldPrice)) {
        merged.verified = false;
      }
      return merged;
    });
    setNotice(undefined);
  }

  function applyDeal(next: AdminDeal, keepEdits: boolean): void {
    setDeal(next);
    setImageFailed(false);
    if (keepEdits) {
      return;
    }
    const filled = fieldsFrom(next);
    setFields(filled);
    setSaved(snapshot(filled));
  }

  async function reload(): Promise<void> {
    setPending('reload');
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}`);
      if (!response.ok) {
        setFormError('The deal could not be reloaded.');
        return;
      }
      applyDeal((await response.json()) as AdminDeal, false);
      setFormError(undefined);
      setFieldErrors({});
    } catch {
      setFormError('The deal could not be reloaded.');
    } finally {
      setPending(undefined);
    }
  }

  async function save(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const errors = validateDealForm(
      {
        title: fields.title,
        price: fields.price,
        oldPrice: fields.oldPrice,
        offer: fields.offer,
        highlights: fields.highlights,
        shortLink: fields.shortLink,
        sourceNote: fields.sourceNote,
        notes: '',
      },
      hosts,
    );
    delete errors.clerkNotes;
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPending('save');
    setFormError(undefined);
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: fields.title,
          price: fields.price,
          oldPrice: fields.oldPrice.trim() === '' ? null : fields.oldPrice,
          offer: fields.offer,
          highlights: fields.highlights
            .map((item) => item.trim())
            .filter((item) => item.length > 0),
          shortLink: fields.shortLink,
          sourceNote: fields.sourceNote,
          previewEnabled: fields.previewEnabled,
          oldPriceVerified: fields.verified && canVerify,
          updatedAt: deal.updatedAt,
        }),
      });
      const body = await readError(response);
      if (response.status === 409) {
        setFormError(body.error ?? STALE_DEAL);
        return;
      }
      if (!response.ok) {
        setFieldErrors(body.fields ?? {});
        setFormError(body.error ?? 'The deal could not be saved.');
        return;
      }
      applyDeal(body as unknown as AdminDeal, false);
      setNotice('Changes saved.');
    } catch {
      setFormError('The deal could not be saved.');
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  }

  async function act(path: string, extra: Record<string, string> = {}): Promise<void> {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPending(path);
    setFormError(undefined);
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updatedAt: deal.updatedAt, ...extra }),
      });
      const body = await readError(response);
      if (response.status === 409) {
        setFormError(body.error ?? STALE_DEAL);
        setModal(undefined);
        return;
      }
      if (!response.ok) {
        const message = body.error ?? 'That action could not be completed.';
        setModalError(message);
        if (modal === undefined) {
          setFormError(message);
        }
        return;
      }
      const next = body as unknown as AdminDeal;
      if (path === 'send-back') {
        setModal(undefined);
        router.push(reviewExitHref('sent_back', deal.createdBy));
        return;
      }
      if (path === 'reject') {
        setModal(undefined);
        router.push(reviewExitHref('rejected'));
        return;
      }
      applyDeal(next, false);
      setModal(undefined);
      setModalText('');
      setNotice(path === 'approve' ? 'Approved.' : undefined);
    } catch {
      setFormError('That action could not be completed.');
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  }

  async function uploadImage(file: File): Promise<void> {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPending('image');
    setFormError(undefined);
    try {
      const body = new FormData();
      body.set('updatedAt', deal.updatedAt);
      body.set('image', file);
      const response = await fetch(`/api/admin/deals/${deal.id}/image`, {
        method: 'POST',
        body,
      });
      const payload = await readError(response);
      if (response.status === 409) {
        setFormError(payload.error ?? STALE_DEAL);
        return;
      }
      if (!response.ok) {
        setFormError(payload.error ?? 'The image could not be saved.');
        return;
      }
      applyDeal(payload as unknown as AdminDeal, true);
      setNotice('Image saved.');
    } catch {
      setFormError('The image could not be saved.');
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  }

  async function removeImage(): Promise<void> {
    if (busy.current) {
      return;
    }
    busy.current = true;
    setPending('image');
    setFormError(undefined);
    try {
      const response = await fetch(`/api/admin/deals/${deal.id}/image`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updatedAt: deal.updatedAt }),
      });
      const payload = await readError(response);
      if (response.status === 409) {
        setFormError(payload.error ?? STALE_DEAL);
        return;
      }
      if (!response.ok) {
        setFormError(payload.error ?? 'The image could not be removed.');
        return;
      }
      applyDeal(payload as unknown as AdminDeal, true);
    } catch {
      setFormError('The image could not be removed.');
    } finally {
      busy.current = false;
      setPending(undefined);
    }
  }

  function submitModal(): void {
    const text = modalText.trim();
    if (text.length === 0) {
      setModalError(modal === 'reject' ? 'Enter a reason.' : 'Enter a note for the person.');
      return;
    }
    if (text.length > 300) {
      setModalError('Keep this under 300 characters.');
      return;
    }
    setModalError(undefined);
    void act(
      modal === 'reject' ? 'reject' : 'send-back',
      modal === 'reject' ? { reason: text } : { note: text },
    );
  }

  const previewHtml = deal.preview.ok ? deal.preview.html : undefined;

  return (
    <section>
      <h1 className="text-3xl font-bold">Review deal</h1>
      <p className="mt-2 text-lg">
        {deal.createdBy} · {deal.status === 'published' ? 'Posted' : 'In review'}
      </p>
      {dirty ? <p className="mt-3 text-lg font-semibold">You have unsaved changes.</p> : null}
      {notice !== undefined ? <p className="mt-3 text-lg">{notice}</p> : null}
      {formError !== undefined ? (
        <div className="mt-3 rounded-xl border border-red-700 bg-white p-4" role="alert">
          <p className="text-lg">{formError}</p>
          {formError === STALE_DEAL ? (
            <button
              type="button"
              className={`mt-3 ${secondaryButton}`}
              onClick={() => void reload()}
            >
              Reload
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <form className="grid gap-4" onSubmit={(event) => void save(event)}>
          {deal.duplicate.hasActiveDeal ? (
            <p className="rounded-xl bg-accent px-4 py-3 text-lg" role="status">
              Another deal for this product is already in the queue.
            </p>
          ) : null}
          {banner !== undefined ? (
            <p className="rounded-xl border border-line bg-white px-4 py-3 text-lg" role="status">
              {banner}
            </p>
          ) : null}
          <label className="grid gap-2 text-lg font-semibold" htmlFor="title">
            Title
            <input
              id="title"
              value={fields.title}
              disabled={!editable}
              onChange={(event) => patchFields({ title: event.target.value })}
              className={fieldClass}
            />
          </label>
          {fieldErrors.title !== undefined ? (
            <p className="text-base font-semibold text-red-700">{fieldErrors.title}</p>
          ) : null}
          <label className="grid gap-2 text-lg font-semibold" htmlFor="price">
            Price
            <input
              id="price"
              inputMode="numeric"
              value={fields.price}
              disabled={!editable}
              onChange={(event) => patchFields({ price: event.target.value })}
              className={fieldClass}
            />
          </label>
          <label className="grid gap-2 text-lg font-semibold" htmlFor="oldPrice">
            Old price
            <input
              id="oldPrice"
              inputMode="numeric"
              value={fields.oldPrice}
              disabled={!editable}
              onChange={(event) => patchFields({ oldPrice: event.target.value })}
              className={fieldClass}
            />
          </label>
          <label className="flex min-h-14 items-center gap-3 text-lg font-semibold">
            <input
              type="checkbox"
              role="switch"
              checked={fields.verified && canVerify}
              disabled={!editable || !canVerify}
              onChange={(event) => patchFields({ verified: event.target.checked })}
            />
            Old price is verified
          </label>
          <p className="text-base">
            Turn on only if you have a real earlier price on record; it adds the % off line to the
            post.
          </p>
          {!canVerify ? (
            <p className="text-base">
              Enter an old price higher than the price before marking it verified.
            </p>
          ) : null}
          <label className="grid gap-2 text-lg font-semibold" htmlFor="offer">
            Offer
            <input
              id="offer"
              value={fields.offer}
              disabled={!editable}
              onChange={(event) => patchFields({ offer: event.target.value })}
              className={fieldClass}
            />
          </label>
          <fieldset className="grid gap-2" disabled={!editable}>
            <legend className="text-lg font-semibold">Highlights</legend>
            {fields.highlights.map((value, index) => (
              <input
                key={index}
                aria-label={`Highlight ${index + 1}`}
                value={value}
                onChange={(event) => {
                  const highlights = [...fields.highlights] as [string, string, string];
                  highlights[index] = event.target.value;
                  patchFields({ highlights });
                }}
                className={fieldClass}
              />
            ))}
          </fieldset>
          <label className="grid gap-2 text-lg font-semibold" htmlFor="shortLink">
            Short link
            <input
              id="shortLink"
              value={fields.shortLink}
              disabled={!editable}
              onChange={(event) => patchFields({ shortLink: event.target.value })}
              className={fieldClass}
            />
          </label>
          <label className="flex min-h-14 items-center gap-3 text-lg font-semibold">
            <input
              type="checkbox"
              checked={fields.previewEnabled}
              disabled={!editable}
              onChange={(event) => patchFields({ previewEnabled: event.target.checked })}
            />
            Link preview
          </label>
          <label className="grid gap-2 text-lg font-semibold" htmlFor="sourceNote">
            Found in group
            <input
              id="sourceNote"
              value={fields.sourceNote}
              disabled={!editable}
              onChange={(event) => patchFields({ sourceNote: event.target.value })}
              className={fieldClass}
            />
          </label>
          <div>
            <p className="text-lg font-semibold">Notes</p>
            <p className="mt-1 text-lg">{deal.clerkNotes?.trim() || 'No notes.'}</p>
          </div>
          <div className="rounded-2xl border border-line bg-white p-4">
            <p className="text-lg font-semibold">Image</p>
            {pending === 'image' ? <p className="mt-3 text-lg">Saving image…</p> : null}
            {deal.hasImage && !imageFailed ? (
              <img
                src={dealImageSrc(deal.id, deal.updatedAt)}
                alt={deal.title}
                className="mt-3 max-h-48 rounded-xl"
                onError={() => setImageFailed(true)}
              />
            ) : (
              <div className="mt-3 flex min-h-32 items-center justify-center rounded-xl border-2 border-dashed border-line">
                No image
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-3">
              <label className={secondaryButton}>
                {deal.hasImage ? 'Replace' : 'Upload'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  disabled={!editable || pending !== undefined}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file !== undefined) {
                      void uploadImage(file);
                    }
                  }}
                />
              </label>
              {deal.hasImage ? (
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={!editable || pending !== undefined}
                  onClick={() => void removeImage()}
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
          <a
            href={deal.productUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={secondaryButton}
          >
            Open product page
          </a>
          <div className="flex flex-wrap gap-3">
            <button
              type="submit"
              className={primaryButton}
              disabled={!editable || pending !== undefined}
            >
              {pending === 'save' ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={deal.status !== 'pending_approval' || pending !== undefined}
              onClick={() => void act('approve')}
            >
              Approve
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={deal.status !== 'pending_approval' || pending !== undefined}
              onClick={() => {
                setModal('back');
                setModalText('');
                setModalError(undefined);
              }}
            >
              Send back
            </button>
            <button
              type="button"
              className={dangerButton}
              disabled={
                (deal.status !== 'pending_approval' && deal.status !== 'approved') ||
                pending !== undefined
              }
              onClick={() => {
                setModal('reject');
                setModalText('');
                setModalError(undefined);
              }}
            >
              Reject
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={deal.status !== 'rejected' || pending !== undefined}
              onClick={() => void act('reopen')}
            >
              Reopen
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={deal.status !== 'approved' || pending !== undefined}
              onClick={() => void act('unapprove')}
            >
              Unapprove
            </button>
            <PublishingControls
              deal={deal}
              pending={pending}
              busy={busy}
              onPending={setPending}
              onDeal={(patch) => setDeal((current) => ({ ...current, ...patch }))}
              onNotice={setNotice}
              onError={setFormError}
            />
          </div>
        </form>
        <aside
          className="rounded-2xl border border-line bg-white p-4"
          aria-label="How the post will look"
        >
          <h2 className="text-2xl font-bold">How the post will look</h2>
          {deal.hasImage && !imageFailed ? (
            <img
              src={dealImageSrc(deal.id, deal.updatedAt)}
              alt=""
              className="mt-4 max-h-64 w-full rounded-xl object-cover"
            />
          ) : (
            <div className="mt-4 flex min-h-32 items-center justify-center rounded-xl border-2 border-dashed border-line">
              No image
            </div>
          )}
          {previewHtml !== undefined ? (
            <div
              className="mt-4 whitespace-pre-wrap text-lg"
              data-testid="post-preview"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <p className="mt-4 text-lg">
              {deal.preview.message ?? 'The post preview is not available.'}
            </p>
          )}
          {deal.preview.warnings.length > 0 ? (
            <ul className="mt-4 list-disc pl-5 text-lg">
              {deal.preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-4 text-lg">{deal.preview.characterCount} / 900</p>
        </aside>
      </div>
      {modal !== undefined ? (
        <Modal
          titleId="review-action-title"
          onClose={() => {
            setModal(undefined);
            setModalError(undefined);
          }}
        >
          <h2 id="review-action-title" className="text-2xl font-bold">
            {modal === 'reject' ? 'Reject this deal' : 'Send back'}
          </h2>
          <label className="mt-4 grid gap-2 text-lg font-semibold" htmlFor="review-note">
            {modal === 'reject' ? 'Reason' : 'Note'}
            <textarea
              id="review-note"
              value={modalText}
              rows={4}
              maxLength={300}
              onChange={(event) => setModalText(event.target.value)}
              className={`${fieldClass} py-3`}
            />
          </label>
          {modalError !== undefined ? (
            <p role="alert" className="mt-3 text-lg">
              {modalError}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              className={modal === 'reject' ? dangerButton : primaryButton}
              disabled={pending !== undefined}
              onClick={submitModal}
            >
              {modal === 'reject' ? 'Reject this deal' : 'Send back'}
            </button>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                setModal(undefined);
                setModalError(undefined);
              }}
            >
              Cancel
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
