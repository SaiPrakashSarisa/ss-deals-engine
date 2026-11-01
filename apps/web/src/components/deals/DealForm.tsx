'use client';

import { formatPost, parsePriceInput, validateShortLink } from '@ss-deals/core';
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { follow } from '../../lib/navigate';
import { bannerForCheck, checkAllowsSave, type UrlBanner } from './banner';
import { PREVIEW_SHORT_HOSTS, validateDealForm } from './validate';

const fieldClass =
  'min-h-14 w-full rounded-xl border-2 border-slate-400 bg-white px-4 text-lg text-ink';

type LoadedDeal = {
  title: string | null;
  productUrl: string;
  taggedUrl: string | null;
  pricePaise: number;
  oldPricePaise: number | null;
  highlights: string[];
  offer: string | null;
  shortLink: string | null;
  sourceNote: string | null;
  clerkNotes: string | null;
  hasImage: boolean;
  status: string;
};

type ErrorBody = { error?: unknown; fields?: Record<string, string> };

function rupeesFromPaise(paise: number | null): string {
  if (paise === null || paise % 100 !== 0) {
    return paise === null ? '' : String(paise / 100);
  }
  return String(paise / 100);
}

function padHighlights(highlights: string[]): [string, string, string] {
  return [highlights[0] ?? '', highlights[1] ?? '', highlights[2] ?? ''];
}

export function DealForm({ dealId: initialDealId }: { dealId?: string }) {
  const [dealId, setDealId] = useState(initialDealId);
  const [productUrl, setProductUrl] = useState('');
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [oldPrice, setOldPrice] = useState('');
  const [offer, setOffer] = useState('');
  const [highlights, setHighlights] = useState<[string, string, string]>(['', '', '']);
  const [shortLink, setShortLink] = useState('');
  const [sourceNote, setSourceNote] = useState('');
  const [notes, setNotes] = useState('');
  const [taggedUrl, setTaggedUrl] = useState<string | null>(null);
  const [banner, setBanner] = useState<UrlBanner | undefined>();
  const [code, setCode] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [pending, setPending] = useState<'draft' | 'review' | undefined>();
  const [loading, setLoading] = useState(initialDealId !== undefined);
  const [locked, setLocked] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [existingImage, setExistingImage] = useState(false);
  const [removeExisting, setRemoveExisting] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | undefined>();
  const urlRef = useRef('');
  const priceRef = useRef('');
  const dealRef = useRef(initialDealId);
  const checkSeq = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  urlRef.current = productUrl;
  priceRef.current = price;
  dealRef.current = dealId;

  useEffect(() => {
    if (file === null) {
      setLocalPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (initialDealId === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/deals/${initialDealId}`);
        const body = (await response.json().catch(() => null)) as {
          deal?: LoadedDeal;
          error?: unknown;
        } | null;
        if (cancelled) {
          return;
        }
        if (!response.ok || body?.deal === undefined) {
          setFormError(typeof body?.error === 'string' ? body.error : 'That deal was not found.');
          setLoading(false);
          return;
        }
        const deal = body.deal;
        const nextPrice = rupeesFromPaise(deal.pricePaise);
        setProductUrl(deal.productUrl);
        setTitle(deal.title ?? '');
        setPrice(nextPrice);
        setOldPrice(rupeesFromPaise(deal.oldPricePaise));
        setOffer(deal.offer ?? '');
        setHighlights(padHighlights(deal.highlights));
        setShortLink(deal.shortLink ?? '');
        setSourceNote(deal.sourceNote ?? '');
        setNotes(deal.clerkNotes ?? '');
        setTaggedUrl(deal.taggedUrl);
        setExistingImage(deal.hasImage);
        setLocked(deal.status !== 'draft');
        urlRef.current = deal.productUrl;
        priceRef.current = nextPrice;
        setLoading(false);
        void runCheck(deal.productUrl, nextPrice, initialDealId);
      } catch {
        if (!cancelled) {
          setFormError('The deal could not be loaded. Try again.');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialDealId]);

  async function runCheck(url: string, priceText: string, id = dealRef.current): Promise<void> {
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      setBanner(undefined);
      setCode(null);
      setTaggedUrl(null);
      return;
    }
    const seq = checkSeq.current + 1;
    checkSeq.current = seq;
    try {
      const response = await fetch('/api/deals/check-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: trimmed,
          price: priceText,
          ...(id === undefined ? {} : { dealId: id }),
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | (UrlBanner & {
            code?: string;
            problems?: string[];
            previousPricePaise?: number | null;
            newPricePaise?: number | null;
            taggedUrl?: string | null;
            error?: unknown;
          })
        | null;
      if (seq !== checkSeq.current) {
        return;
      }
      if (!response.ok || body === null || typeof body.code !== 'string') {
        setCode(null);
        setBanner({
          tone: 'bad',
          text:
            typeof body?.error === 'string' ? body.error : 'The product link could not be checked.',
        });
        return;
      }
      setCode(body.code);
      setTaggedUrl(typeof body.taggedUrl === 'string' ? body.taggedUrl : null);
      setBanner(
        bannerForCheck({
          code: body.code,
          problems: Array.isArray(body.problems)
            ? body.problems.filter((item) => typeof item === 'string')
            : [],
          previousPricePaise:
            typeof body.previousPricePaise === 'number' ? body.previousPricePaise : null,
          newPricePaise: typeof body.newPricePaise === 'number' ? body.newPricePaise : null,
        }),
      );
    } catch {
      if (seq === checkSeq.current) {
        setCode(null);
        setBanner({ tone: 'bad', text: 'The product link could not be checked.' });
      }
    }
  }

  function onUrlPaste(event: ClipboardEvent<HTMLInputElement>): void {
    const text = event.clipboardData.getData('text').trim();
    if (text.length === 0) {
      return;
    }
    event.preventDefault();
    urlRef.current = text;
    setProductUrl(text);
    setCode(null);
    void runCheck(text, priceRef.current);
  }

  function onPricePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const parsed = parsePriceInput(event.clipboardData.getData('text'));
    if (parsed === undefined) {
      return;
    }
    event.preventDefault();
    const next = String(parsed);
    priceRef.current = next;
    setPrice(next);
    if (code === 'posted_lower' || code === 'posted_blocked' || code === 'awaiting_price') {
      setCode(null);
    }
    void runCheck(urlRef.current, next);
  }

  function onOldPricePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const parsed = parsePriceInput(event.clipboardData.getData('text'));
    if (parsed === undefined) {
      return;
    }
    event.preventDefault();
    setOldPrice(String(parsed));
  }

  function clearImage(): void {
    setFile(null);
    if (existingImage) {
      setRemoveExisting(true);
    }
    if (fileInput.current !== null) {
      fileInput.current.value = '';
    }
  }

  async function persist(intent: 'draft' | 'review'): Promise<void> {
    setFormError(undefined);
    setNotice(undefined);
    const fields = validateDealForm({
      title,
      price,
      oldPrice,
      offer,
      highlights: [...highlights],
      shortLink,
      sourceNote,
      notes,
    });
    setFieldErrors(fields);
    if (Object.keys(fields).length > 0 || !checkAllowsSave(code)) {
      if (Object.keys(fields).length > 0) {
        setFormError('Check the highlighted fields.');
      }
      return;
    }

    setPending(intent);
    try {
      const payload = {
        productUrl: productUrl.trim(),
        title,
        price,
        oldPrice,
        offer,
        highlights,
        shortLink,
        sourceNote,
        clerkNotes: notes,
      };
      const path = dealId === undefined ? '/api/deals' : `/api/deals/${dealId}`;
      const method = dealId === undefined ? 'POST' : 'PATCH';
      const saved = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const savedBody = (await saved.json().catch(() => null)) as {
        deal?: { id?: string };
        error?: unknown;
        fields?: Record<string, string>;
      } | null;
      if (!saved.ok || typeof savedBody?.deal?.id !== 'string') {
        applyError(saved.status, savedBody);
        return;
      }
      const id = savedBody.deal.id;
      setDealId(id);
      dealRef.current = id;
      window.history.replaceState(null, '', `/deals/new?id=${id}`);

      if (file !== null) {
        const data = new FormData();
        data.append('image', file);
        const uploaded = await fetch(`/api/deals/${id}/image`, { method: 'POST', body: data });
        const uploadedBody = (await uploaded.json().catch(() => null)) as ErrorBody | null;
        if (!uploaded.ok) {
          applyError(uploaded.status, uploadedBody);
          return;
        }
        setFile(null);
        setExistingImage(true);
        setRemoveExisting(false);
      } else if (removeExisting) {
        const removed = await fetch(`/api/deals/${id}/image`, { method: 'DELETE' });
        if (!removed.ok && removed.status !== 404) {
          const removedBody = (await removed.json().catch(() => null)) as ErrorBody | null;
          applyError(removed.status, removedBody);
          return;
        }
        setExistingImage(false);
        setRemoveExisting(false);
      }

      if (intent === 'review') {
        const submitted = await fetch(`/api/deals/${id}/submit`, { method: 'POST' });
        const submittedBody = (await submitted.json().catch(() => null)) as ErrorBody | null;
        if (!submitted.ok) {
          applyError(submitted.status, submittedBody);
          return;
        }
        follow('/deals/mine');
        return;
      }
      setNotice('Draft saved.');
    } catch {
      setFormError('The deal could not be saved. Try again.');
    } finally {
      setPending(undefined);
    }
  }

  function applyError(status: number, body: ErrorBody | null): void {
    if (body?.fields !== undefined) {
      setFieldErrors(body.fields);
    }
    if (status === 429) {
      setFormError(
        typeof body?.error === 'string' ? body.error : 'Too many attempts. Wait and try again.',
      );
      return;
    }
    setFormError(
      typeof body?.error === 'string' ? body.error : 'The deal could not be saved. Try again.',
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const intent =
      submitter instanceof HTMLButtonElement && submitter.value === 'review' ? 'review' : 'draft';
    void persist(intent);
  }

  const preview = buildPreview({ title, price, oldPrice, offer, highlights, shortLink, taggedUrl });
  const imageSrc =
    localPreview ??
    (existingImage && !removeExisting && dealId !== undefined
      ? `/api/deals/${dealId}/image`
      : undefined);
  const canSave = checkAllowsSave(code) && pending === undefined && !loading && !locked;
  const toneClass = {
    good: 'border-green-700 bg-green-50',
    warn: 'border-amber-500 bg-amber-50',
    bad: 'border-red-700 bg-red-50',
  };

  if (loading) {
    return <p className="text-xl">Loading the deal…</p>;
  }

  return (
    <div className="grid gap-8">
      <form className="grid gap-5" noValidate onSubmit={onSubmit}>
        <p className="text-lg">
          <span className="text-red-600">*</span> required
        </p>
        {formError !== undefined ? (
          <p
            role="alert"
            className="rounded-xl border-2 border-red-700 bg-red-50 px-4 py-3 text-lg"
          >
            {formError}
          </p>
        ) : null}
        {notice !== undefined ? (
          <p className="text-lg font-semibold text-primary">{notice}</p>
        ) : null}
        {locked ? <p className="text-lg">This deal can no longer be changed.</p> : null}

        <Field
          id="productUrl"
          label="Product page URL"
          required
          hint="Paste the product page link from the address bar"
          error={fieldErrors.productUrl}
        >
          <input
            id="productUrl"
            name="productUrl"
            value={productUrl}
            aria-required="true"
            aria-invalid={fieldErrors.productUrl !== undefined}
            onChange={(event) => {
              urlRef.current = event.target.value;
              setProductUrl(event.target.value);
              setCode(null);
              setTaggedUrl(null);
            }}
            onBlur={() => void runCheck(urlRef.current, priceRef.current)}
            onPaste={onUrlPaste}
            className={fieldClass}
          />
        </Field>
        {banner !== undefined ? (
          <div
            role="status"
            className={`rounded-xl border-2 px-4 py-3 text-lg ${toneClass[banner.tone]}`}
          >
            <p className="font-semibold">{banner.text}</p>
            {banner.detail !== undefined ? <p className="mt-1">{banner.detail}</p> : null}
          </div>
        ) : null}

        <Field id="title" label="Title" required error={fieldErrors.title}>
          <input
            id="title"
            name="title"
            value={title}
            aria-required="true"
            aria-invalid={fieldErrors.title !== undefined}
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            className={fieldClass}
          />
        </Field>

        <Field id="price" label="Price" required error={fieldErrors.price}>
          <div className="flex min-h-14 items-center rounded-xl border-2 border-slate-400 bg-white">
            <span className="pl-4 text-lg font-semibold" aria-hidden="true">
              ₹
            </span>
            <input
              id="price"
              name="price"
              inputMode="numeric"
              autoComplete="off"
              value={price}
              aria-required="true"
              aria-invalid={fieldErrors.price !== undefined}
              onChange={(event) => {
                priceRef.current = event.target.value;
                setPrice(event.target.value);
                if (
                  code === 'posted_lower' ||
                  code === 'posted_blocked' ||
                  code === 'awaiting_price'
                ) {
                  setCode(null);
                }
              }}
              onBlur={() => {
                const parsed = parsePriceInput(priceRef.current);
                const next = parsed === undefined ? priceRef.current.trim() : String(parsed);
                priceRef.current = next;
                setPrice(next);
                void runCheck(urlRef.current, next);
              }}
              onPaste={onPricePaste}
              className="min-h-14 w-full bg-transparent px-3 text-lg text-ink outline-none"
            />
          </div>
        </Field>

        <Field id="oldPrice" label="Old price" error={fieldErrors.oldPrice}>
          <div className="flex min-h-14 items-center rounded-xl border-2 border-slate-400 bg-white">
            <span className="pl-4 text-lg font-semibold" aria-hidden="true">
              ₹
            </span>
            <input
              id="oldPrice"
              name="oldPrice"
              inputMode="numeric"
              autoComplete="off"
              value={oldPrice}
              aria-invalid={fieldErrors.oldPrice !== undefined}
              onChange={(event) => setOldPrice(event.target.value)}
              onBlur={() => {
                const parsed = parsePriceInput(oldPrice);
                if (parsed !== undefined) {
                  setOldPrice(String(parsed));
                }
              }}
              onPaste={onOldPricePaste}
              className="min-h-14 w-full bg-transparent px-3 text-lg text-ink outline-none"
            />
          </div>
        </Field>

        <Field id="offer" label="Offer" error={fieldErrors.offer}>
          <input
            id="offer"
            name="offer"
            value={offer}
            maxLength={120}
            aria-invalid={fieldErrors.offer !== undefined}
            onChange={(event) => setOffer(event.target.value)}
            className={fieldClass}
          />
        </Field>

        <fieldset className="grid gap-2">
          <legend className="text-lg font-semibold">Highlights</legend>
          {highlights.map((value, index) => (
            <input
              key={index}
              aria-label={`Highlight ${index + 1}`}
              value={value}
              maxLength={80}
              onChange={(event) => {
                const next = [...highlights] as [string, string, string];
                next[index] = event.target.value;
                setHighlights(next);
              }}
              className={fieldClass}
            />
          ))}
          {fieldErrors.highlights !== undefined ? (
            <p className="text-base font-semibold text-red-700">{fieldErrors.highlights}</p>
          ) : null}
        </fieldset>

        <Field
          id="shortLink"
          label="Short link"
          hint="From the Associates SiteStripe bar. You can leave this empty."
          error={fieldErrors.shortLink}
        >
          <input
            id="shortLink"
            name="shortLink"
            value={shortLink}
            aria-invalid={fieldErrors.shortLink !== undefined}
            onChange={(event) => setShortLink(event.target.value)}
            className={fieldClass}
          />
        </Field>

        <Field id="sourceNote" label="Found in group" error={fieldErrors.sourceNote}>
          <input
            id="sourceNote"
            name="sourceNote"
            value={sourceNote}
            maxLength={120}
            aria-invalid={fieldErrors.sourceNote !== undefined}
            onChange={(event) => setSourceNote(event.target.value)}
            className={fieldClass}
          />
        </Field>

        <Field id="notes" label="Notes" error={fieldErrors.clerkNotes}>
          <textarea
            id="notes"
            name="notes"
            value={notes}
            maxLength={300}
            rows={4}
            aria-invalid={fieldErrors.clerkNotes !== undefined}
            onChange={(event) => setNotes(event.target.value)}
            className={`${fieldClass} py-3`}
          />
        </Field>

        <Field id="image" label="Image">
          <input
            id="image"
            ref={fileInput}
            name="image"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              if (picked === undefined) {
                return;
              }
              setFile(picked);
              setRemoveExisting(false);
            }}
            className="block min-h-14 w-full text-lg"
          />
          {imageSrc !== undefined ? (
            <img
              src={imageSrc}
              alt={file === null ? 'Deal image' : 'Chosen image'}
              className="mt-3 max-h-64 rounded-xl"
            />
          ) : null}
          {imageSrc !== undefined ? (
            <button
              type="button"
              onClick={clearImage}
              className="mt-3 inline-flex min-h-12 items-center rounded-xl border-2 border-slate-500 px-4 text-lg font-semibold"
            >
              Remove
            </button>
          ) : null}
        </Field>

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            value="draft"
            disabled={!canSave}
            className="inline-flex min-h-14 items-center justify-center rounded-xl border-2 border-primary px-5 text-lg font-semibold text-primary disabled:opacity-50"
          >
            {pending === 'draft' ? 'Saving…' : 'Save draft'}
          </button>
          <button
            type="submit"
            value="review"
            disabled={!canSave}
            className="inline-flex min-h-14 items-center justify-center rounded-xl bg-primary px-5 text-lg font-semibold text-white disabled:opacity-50"
          >
            {pending === 'review' ? 'Sending…' : 'Send for review'}
          </button>
        </div>
      </form>

      <section className="rounded-2xl border border-line bg-white p-5">
        <h2 className="text-2xl font-bold">How the post will look</h2>
        <p className="mt-2 text-lg">Preview - an admin may change it</p>
        {preview === undefined ? (
          <p className="mt-4 text-lg">Fill in the title, price, and product link.</p>
        ) : preview.ok ? (
          <div
            className="mt-4 whitespace-pre-wrap text-lg"
            dangerouslySetInnerHTML={{ __html: preview.html }}
          />
        ) : (
          <p className="mt-4 text-lg">{preview.message}</p>
        )}
      </section>
    </div>
  );
}

function buildPreview(input: {
  title: string;
  price: string;
  oldPrice: string;
  offer: string;
  highlights: string[];
  shortLink: string;
  taggedUrl: string | null;
}) {
  const amount = parsePriceInput(input.price);
  const title = input.title.trim();
  if (amount === undefined || title.length === 0 || input.taggedUrl === null) {
    return undefined;
  }
  const oldAmount = input.oldPrice.trim() === '' ? undefined : parsePriceInput(input.oldPrice);
  const shortLink = input.shortLink.trim();
  const shortOk = shortLink.length > 0 && validateShortLink(shortLink, PREVIEW_SHORT_HOSTS).ok;
  return formatPost({
    title,
    price: amount,
    oldPrice: oldAmount !== undefined && oldAmount > amount ? oldAmount : undefined,
    verified: false,
    highlights: input.highlights.map((item) => item.trim()).filter((item) => item.length > 0),
    offer: input.offer.trim() === '' ? undefined : input.offer.trim(),
    linkUrl: shortOk ? shortLink : input.taggedUrl,
    linkStyle: 'text',
  });
}

function Field({
  id,
  label,
  required = false,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <label className="text-lg font-semibold" htmlFor={id}>
        {label}
        {required ? (
          <span className="text-red-600" aria-hidden="true">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {hint !== undefined ? <p className="text-base text-slate-700">{hint}</p> : null}
      {children}
      {error !== undefined ? <p className="text-base font-semibold text-red-700">{error}</p> : null}
    </div>
  );
}
