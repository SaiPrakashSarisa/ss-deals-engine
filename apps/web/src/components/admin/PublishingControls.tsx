'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import { formatIst, istInputLimits, parseIstInput } from './ist';
import type { AdminDeal, PublicationItem, PublishingStatus } from './types';

const secondaryButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl border-2 border-primary px-5 text-lg font-semibold text-primary disabled:opacity-60';
const primaryButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl bg-primary px-5 text-lg font-semibold text-white disabled:opacity-60';

type Step = 'confirm' | 'override' | 'unknown' | 'schedule' | 'message' | undefined;

async function readError(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error;
}

export function PublishingControls({
  deal,
  pending,
  busy,
  onPending,
  onDeal,
  onNotice,
  onError,
  now = () => new Date(),
}: {
  deal: AdminDeal;
  pending: string | undefined;
  busy: MutableRefObject<boolean>;
  onPending: (value: string | undefined) => void;
  onDeal: (patch: Pick<AdminDeal, 'status' | 'updatedAt'>) => void;
  onNotice: (message: string | undefined) => void;
  onError: (message: string | undefined) => void;
  now?: () => Date;
}) {
  const [step, setStep] = useState<Step>();
  const [channel, setChannel] = useState<string | null>(null);
  const [publication, setPublication] = useState<PublicationItem | undefined>();
  const [when, setWhen] = useState('');
  const [checked, setChecked] = useState(false);
  const [messageId, setMessageId] = useState('');
  const limits = istInputLimits(now());
  const locked = pending !== undefined;
  const canPost = deal.status === 'approved' && !locked;

  useEffect(() => {
    if (deal.status !== 'approved' && deal.status !== 'scheduled' && deal.status !== 'published') {
      return;
    }
    let cancel = false;
    void fetch('/api/admin/publications?pageSize=50')
      .then(async (response) => {
        if (!response.ok || cancel) {
          return;
        }
        const body = (await response.json()) as { items?: PublicationItem[] };
        const match = body.items?.find((item) => item.dealId === deal.id);
        if (match !== undefined && !cancel) {
          setPublication(match);
        }
      })
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [deal.id, deal.status, deal.updatedAt]);

  async function run(
    name: string,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    error?: string;
    body?: { publication?: PublicationItem; deal?: { status: string; updatedAt: string } };
  }> {
    if (busy.current) {
      return { ok: false };
    }
    busy.current = true;
    onPending(name);
    onError(undefined);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        publication?: PublicationItem;
        deal?: { status: string; updatedAt: string };
      };
      if (!response.ok) {
        return { ok: false, error: body.error };
      }
      return { ok: true, body };
    } catch {
      return { ok: false, error: 'That action could not be completed.' };
    } finally {
      busy.current = false;
      onPending(undefined);
    }
  }

  function apply(
    result: { publication?: PublicationItem; deal?: { status: string; updatedAt: string } },
    notice: string,
  ): void {
    if (result.deal !== undefined) {
      onDeal({ status: result.deal.status, updatedAt: result.deal.updatedAt });
    }
    if (result.publication !== undefined) {
      setPublication({
        ...result.publication,
        title: deal.title,
        mode: result.publication.mode ?? 'text',
        origin: result.publication.origin ?? 'app',
        scheduledFor: result.publication.scheduledFor ?? null,
        createdAt: result.publication.createdAt ?? deal.updatedAt,
      });
    }
    onNotice(notice);
    setStep(undefined);
  }

  async function openPublish(): Promise<void> {
    onError(undefined);
    const response = await fetch('/api/admin/publishing/status');
    if (!response.ok) {
      onError((await readError(response)) ?? 'Publishing status could not be loaded.');
      return;
    }
    const status = (await response.json()) as PublishingStatus;
    setChannel(status.channel);
    setChecked(false);
    setStep('confirm');
  }

  async function send(extra: Record<string, boolean> = {}): Promise<void> {
    const result = await run('publish', `/api/admin/deals/${deal.id}/publish`, {
      updatedAt: deal.updatedAt,
      ...extra,
    });
    if (result.ok && result.body !== undefined) {
      apply(result.body, 'Posted.');
      return;
    }
    const error = result.error ?? 'The post could not be sent.';
    if (/post limit/i.test(error)) {
      setStep('override');
      return;
    }
    if (/earlier posted price/i.test(error)) {
      setStep('unknown');
      return;
    }
    onError(error);
    setStep(undefined);
  }

  async function schedule(): Promise<void> {
    const scheduledFor = parseIstInput(when);
    if (Number.isNaN(scheduledFor.getTime())) {
      onError('Choose a time in the future.');
      return;
    }
    const result = await run('schedule', `/api/admin/deals/${deal.id}/schedule`, {
      updatedAt: deal.updatedAt,
      scheduledFor: scheduledFor.toISOString(),
    });
    if (!result.ok || result.body?.publication === undefined || result.body.deal === undefined) {
      onError(result.error ?? 'The deal could not be scheduled.');
      return;
    }
    apply(
      {
        deal: result.body.deal,
        publication: {
          ...result.body.publication,
          title: deal.title,
          mode: 'text',
          origin: 'app',
          scheduledFor: scheduledFor.toISOString(),
          createdAt: deal.updatedAt,
        },
      },
      'Scheduled.',
    );
  }

  async function unschedule(): Promise<void> {
    const result = await run('unschedule', `/api/admin/deals/${deal.id}/unschedule`, {
      updatedAt: deal.updatedAt,
    });
    if (!result.ok || result.body?.deal === undefined) {
      onError(result.error ?? 'The deal could not be unscheduled.');
      return;
    }
    setPublication(undefined);
    onDeal(result.body.deal);
    onNotice('Unscheduled.');
  }

  async function resolve(outcome: 'posted' | 'not_posted'): Promise<void> {
    if (publication === undefined) {
      return;
    }
    const result = await run('resolve', `/api/admin/publications/${publication.id}/resolve`, {
      outcome,
      ...(messageId.trim() === '' ? {} : { messageId: messageId.trim() }),
    });
    if (!result.ok || result.body === undefined) {
      onError(result.error ?? 'The post could not be resolved.');
      return;
    }
    apply(result.body, outcome === 'posted' ? 'Posted.' : 'Marked as not posted.');
    setMessageId('');
  }

  const shownTime = publication?.publishedAt ?? publication?.scheduledFor ?? null;

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          className={secondaryButton}
          disabled={!canPost}
          onClick={() => void openPublish()}
        >
          Publish now
        </button>
        <button
          type="button"
          className={secondaryButton}
          disabled={!canPost}
          onClick={() => {
            setWhen(limits.min);
            setStep('schedule');
            onError(undefined);
          }}
        >
          Schedule
        </button>
        {deal.status === 'scheduled' ? (
          <button
            type="button"
            className={secondaryButton}
            disabled={locked}
            onClick={() => void unschedule()}
          >
            {pending === 'unschedule' ? 'Working…' : 'Unschedule'}
          </button>
        ) : null}
      </div>
      {step === 'confirm' ? (
        <div
          role="dialog"
          aria-label="Publish now"
          className="rounded-2xl border border-line bg-white p-4"
        >
          <p className="text-lg">Post this to {channel ?? 'the channel'}?</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className={primaryButton}
              disabled={locked}
              onClick={() => void send()}
            >
              {pending === 'publish' ? 'Posting…' : 'Post it'}
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={locked}
              onClick={() => setStep(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {step === 'override' ? (
        <div
          role="dialog"
          aria-label="Daily limit"
          className="rounded-2xl border border-line bg-white p-4"
        >
          <p className="text-lg">Today's post limit has been reached.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className={primaryButton}
              disabled={locked}
              onClick={() => void send({ override: true })}
            >
              Override
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={locked}
              onClick={() => setStep(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {step === 'unknown' ? (
        <div
          role="dialog"
          aria-label="Earlier price"
          className="rounded-2xl border border-line bg-white p-4"
        >
          <label className="flex min-h-14 items-center gap-3 text-lg">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            I checked the channel and this product was not posted recently
          </label>
          <button
            type="button"
            className={`${primaryButton} mt-3`}
            disabled={!checked || locked}
            onClick={() => void send({ override: true, confirmUnknownPrice: true })}
          >
            Post it
          </button>
        </div>
      ) : null}
      {step === 'schedule' ? (
        <div
          role="dialog"
          aria-label="Schedule"
          className="rounded-2xl border border-line bg-white p-4"
        >
          <label className="block text-lg font-semibold" htmlFor="schedule-time">
            India time
          </label>
          <input
            id="schedule-time"
            type="datetime-local"
            className="mt-2 min-h-14 w-full rounded-xl border-2 border-slate-400 px-4 text-lg"
            min={limits.min}
            max={limits.max}
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className={primaryButton}
              disabled={locked || when === ''}
              onClick={() => void schedule()}
            >
              {pending === 'schedule' ? 'Scheduling…' : 'Schedule this time'}
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={locked}
              onClick={() => setStep(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {deal.status === 'scheduled' && publication?.scheduledFor ? (
        <p className="text-lg">Scheduled for {formatIst(publication.scheduledFor)}.</p>
      ) : null}
      {publication?.status === 'published' && shownTime ? (
        <p className="text-lg">Posted {formatIst(publication.publishedAt)}.</p>
      ) : null}
      {publication?.status === 'failed' ? (
        <p className="text-lg" role="alert">
          Could not post. {publication.lastError ?? 'The post failed.'}
        </p>
      ) : null}
      {publication?.status === 'uncertain' ? (
        <div className="rounded-2xl border border-line bg-white p-4">
          <p className="text-lg">Check the channel.</p>
          {step === 'message' ? (
            <label className="mt-3 block text-lg">
              Message id
              <input
                className="mt-2 min-h-14 w-full rounded-xl border-2 border-slate-400 px-4 text-lg"
                value={messageId}
                onChange={(event) => setMessageId(event.target.value)}
              />
            </label>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className={primaryButton}
              disabled={locked}
              onClick={() => {
                if (step !== 'message') {
                  setStep('message');
                  return;
                }
                void resolve('posted');
              }}
            >
              It was posted
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={locked}
              onClick={() => void resolve('not_posted')}
            >
              It was not posted
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
