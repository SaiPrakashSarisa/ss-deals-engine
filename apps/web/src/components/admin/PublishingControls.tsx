'use client';

import { useEffect, useState, type MutableRefObject } from 'react';
import { formatPaise } from '../../lib/money';
import { dealImageSrc } from '../deal-image';
import { Modal } from '../deals/Modal';
import {
  formatIst,
  formatIstSchedule,
  istInputLimits,
  parseIstInput,
  quickScheduleChoices,
} from './ist';
import type { AdminDeal, PublicationItem, PublishingStatus } from './types';

const secondaryButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl border-2 border-primary px-5 text-lg font-semibold text-primary disabled:opacity-60';
const primaryButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl bg-primary px-5 text-lg font-semibold text-white disabled:opacity-60';
const publishButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl bg-green-700 px-6 text-lg font-semibold text-white disabled:opacity-60';

type PublishStep = 'confirm' | 'limit' | 'unknown' | 'sending' | 'posted' | 'failed' | 'uncertain';
type ScheduleStep = 'pick' | 'done';

type Warning = { code?: string; message?: string; earliest?: string };

function channelLabel(channel: string | null): string {
  if (channel === null || channel.trim() === '') {
    return '@channel';
  }
  return channel.startsWith('@') ? channel : `@${channel}`;
}

function postUrl(channel: string | null, messageId: string | null): string | null {
  if (channel === null || messageId === null || messageId.trim() === '') {
    return null;
  }
  const name = channel.replace(/^@/, '');
  if (name.length === 0 || name.startsWith('-')) {
    return null;
  }
  return `https://t.me/${name}/${messageId}`;
}

function statusText(item: PublicationItem | undefined): string | null {
  if (item === undefined) {
    return null;
  }
  if (typeof item.statusLine === 'string' && item.statusLine.length > 0) {
    return item.statusLine;
  }
  if (item.lastError === null || item.lastError.startsWith('retry_at:')) {
    return null;
  }
  return item.lastError;
}

function countdown(target: string, now: number): string {
  const remaining = new Date(target).getTime() - now;
  if (Number.isNaN(remaining) || remaining <= 0) {
    return 'Due now';
  }
  const total = Math.floor(remaining / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

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
  const [publishStep, setPublishStep] = useState<PublishStep | undefined>();
  const [scheduleStep, setScheduleStep] = useState<ScheduleStep | undefined>();
  const [channel, setChannel] = useState<string | null>(null);
  const [publication, setPublication] = useState<PublicationItem | undefined>();
  const [when, setWhen] = useState('');
  const [warnings, setWarnings] = useState<Warning[]>([]);
  const [checked, setChecked] = useState(false);
  const [failure, setFailure] = useState('');
  const [definite, setDefinite] = useState(true);
  const [messageId, setMessageId] = useState('');
  const [tick, setTick] = useState(() => now().getTime());
  const limits = istInputLimits(now());
  const locked = pending !== undefined;
  const canPost = deal.status === 'approved' && !locked;
  const name = channelLabel(channel);
  const line = statusText(publication);

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

  useEffect(() => {
    if (deal.status !== 'scheduled' || publication?.scheduledFor === undefined) {
      return;
    }
    const timer = setInterval(() => setTick(now().getTime()), 1000);
    return () => clearInterval(timer);
  }, [deal.status, now, publication?.scheduledFor]);

  useEffect(() => {
    if (scheduleStep !== 'pick' || when === '') {
      return;
    }
    const at = parseIstInput(when);
    if (Number.isNaN(at.getTime())) {
      return;
    }
    let cancel = false;
    void fetch(
      `/api/admin/publishing/schedule-hint?at=${encodeURIComponent(at.toISOString())}&dealId=${deal.id}`,
    )
      .then(async (response) => {
        if (!response.ok || cancel) {
          return;
        }
        const body = (await response.json()) as { warnings?: Warning[] };
        if (!cancel) {
          setWarnings(Array.isArray(body.warnings) ? body.warnings : []);
        }
      })
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, [deal.id, scheduleStep, when]);

  async function run(
    name: string,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    error?: string;
    body?: {
      publication?: PublicationItem;
      deal?: { status: string; updatedAt: string };
      warnings?: Warning[];
    };
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
        warnings?: Warning[];
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

  function remember(
    result: { publication?: PublicationItem; deal?: { status: string; updatedAt: string } },
    scheduledFor?: string,
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
        scheduledFor: scheduledFor ?? result.publication.scheduledFor ?? null,
        createdAt: result.publication.createdAt ?? deal.updatedAt,
      });
    }
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
    setFailure('');
    setPublishStep('confirm');
  }

  async function send(extra: Record<string, boolean> = {}): Promise<void> {
    setPublishStep('sending');
    const result = await run('publish', `/api/admin/deals/${deal.id}/publish`, {
      updatedAt: deal.updatedAt,
      ...extra,
    });
    if (result.ok && result.body?.publication?.status === 'published') {
      remember(result.body);
      setPublishStep('posted');
      return;
    }
    if (result.ok && result.body?.publication?.status === 'uncertain') {
      remember(result.body);
      setPublishStep('uncertain');
      return;
    }
    const error = result.error ?? 'The post could not be sent.';
    if (/post limit/i.test(error)) {
      setPublishStep('limit');
      return;
    }
    if (/earlier posted price/i.test(error)) {
      setPublishStep('unknown');
      return;
    }
    setFailure(error);
    setDefinite(!/could not confirm|check the channel/i.test(error));
    setPublishStep('failed');
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
    remember(result.body, scheduledFor.toISOString());
    setWarnings(result.body.warnings ?? warnings);
    setScheduleStep('done');
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
    remember(result.body);
    onNotice(outcome === 'posted' ? 'Posted.' : 'Marked as not posted.');
    setMessageId('');
    setPublishStep(undefined);
  }

  const shownTime = publication?.publishedAt ?? publication?.scheduledFor ?? null;
  const view = postUrl(channel, publication?.externalMessageId ?? null);

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
            setWarnings([]);
            setScheduleStep('pick');
            onError(undefined);
          }}
        >
          Schedule
        </button>
      </div>
      {deal.status === 'scheduled' && publication?.scheduledFor ? (
        <section
          className="rounded-2xl border-2 border-green-700 bg-white p-4"
          aria-label="Scheduled"
        >
          <h2 className="text-2xl font-bold">Scheduled</h2>
          <p className="mt-2 text-lg">{formatIstSchedule(publication.scheduledFor)} (IST)</p>
          <p className="mt-1 text-lg">{countdown(publication.scheduledFor, tick)}</p>
          {line !== null ? <p className="mt-1 text-lg">{line}</p> : null}
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="button"
              className={secondaryButton}
              disabled={locked}
              onClick={() => void unschedule()}
            >
              {pending === 'unschedule' ? 'Working…' : 'Unschedule'}
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={locked}
              onClick={() => {
                setWhen(istInputLimits(now()).min);
                setScheduleStep('pick');
              }}
            >
              Reschedule
            </button>
          </div>
        </section>
      ) : null}
      {publication?.status === 'published' && shownTime ? (
        <p className="text-lg">Posted {formatIst(publication.publishedAt)}.</p>
      ) : null}
      {publication?.status === 'failed' ? (
        <p className="text-lg" role="alert">
          Could not post. {publication.lastError ?? 'The post failed.'}
        </p>
      ) : null}
      {publication?.status === 'uncertain' && publishStep === undefined ? (
        <UncertainPanel
          locked={locked}
          messageId={messageId}
          onMessageId={setMessageId}
          onResolve={(outcome) => void resolve(outcome)}
        />
      ) : null}
      {publishStep !== undefined ? (
        <Modal
          titleId="publish-title"
          closable={publishStep !== 'sending'}
          onClose={() => {
            if (publishStep === 'posted') {
              onNotice('Posted.');
            }
            setPublishStep(undefined);
          }}
        >
          <h2 id="publish-title" className="text-2xl font-bold">
            {publishStep === 'posted'
              ? 'Posted'
              : publishStep === 'failed'
                ? 'Could not post'
                : publishStep === 'uncertain'
                  ? 'Check the channel'
                  : `Post this deal to ${name}?`}
          </h2>
          <div className="mt-4" aria-live="polite">
            {publishStep === 'confirm' ? (
              <ConfirmStep
                deal={deal}
                locked={locked}
                onCancel={() => setPublishStep(undefined)}
                onPublish={() => void send()}
              />
            ) : null}
            {publishStep === 'sending' ? (
              <div className="grid justify-items-center gap-4 py-6">
                <div
                  className="h-24 w-24 animate-spin rounded-full border-8 border-green-200 border-t-green-700"
                  role="status"
                />
                <p className="text-xl">Posting to {name}...</p>
              </div>
            ) : null}
            {publishStep === 'posted' ? (
              <div className="grid justify-items-center gap-4 py-4">
                <Tick />
                {view !== null ? (
                  <a href={view} className="text-lg font-semibold text-primary underline">
                    View post
                  </a>
                ) : null}
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => {
                    onNotice('Posted.');
                    setPublishStep(undefined);
                  }}
                >
                  Close
                </button>
              </div>
            ) : null}
            {publishStep === 'failed' ? (
              <div className="grid justify-items-center gap-4 py-4">
                <Cross />
                <p className="text-lg" role="alert">
                  {failure}
                </p>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => setPublishStep(undefined)}
                  >
                    Close
                  </button>
                  {definite ? (
                    <button type="button" className={publishButton} onClick={() => void send()}>
                      Try again
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {publishStep === 'uncertain' ? (
              <div className="grid gap-4">
                <p className="rounded-xl border-2 border-amber-500 bg-amber-50 px-4 py-3 text-lg">
                  We could not confirm the post. Check the channel
                </p>
                <UncertainPanel
                  locked={locked}
                  messageId={messageId}
                  onMessageId={setMessageId}
                  onResolve={(outcome) => void resolve(outcome)}
                />
              </div>
            ) : null}
            {publishStep === 'limit' ? (
              <div>
                <p className="text-lg">Today's post limit has been reached.</p>
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    type="button"
                    className={publishButton}
                    disabled={locked}
                    onClick={() => void send({ override: true })}
                  >
                    Override
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={locked}
                    onClick={() => setPublishStep(undefined)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {publishStep === 'unknown' ? (
              <div>
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
                  className={`${publishButton} mt-3`}
                  disabled={!checked || locked}
                  onClick={() => void send({ override: true, confirmUnknownPrice: true })}
                >
                  Publish now
                </button>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {scheduleStep !== undefined ? (
        <Modal titleId="schedule-title" onClose={() => setScheduleStep(undefined)}>
          <h2 id="schedule-title" className="text-2xl font-bold">
            {scheduleStep === 'done' ? 'Scheduled' : 'Schedule'}
          </h2>
          <div className="mt-4" aria-live="polite">
            {scheduleStep === 'pick' ? (
              <div>
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
                <div className="mt-3 flex flex-wrap gap-2">
                  {quickScheduleChoices(now()).map((choice) => (
                    <button
                      key={choice.label}
                      type="button"
                      className={secondaryButton}
                      onClick={() => setWhen(choice.value)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
                {warnings.map((warning) => (
                  <p
                    key={`${warning.code ?? ''}-${warning.earliest ?? ''}`}
                    className="mt-3 text-lg"
                  >
                    {warning.message}
                    {warning.earliest !== undefined
                      ? ` Earliest ${formatIstSchedule(warning.earliest)} (IST).`
                      : ''}
                  </p>
                ))}
                <div className="mt-3 flex flex-wrap gap-3">
                  <button
                    type="button"
                    className={publishButton}
                    disabled={locked || when === ''}
                    onClick={() => void schedule()}
                  >
                    {pending === 'schedule' ? 'Scheduling…' : 'Schedule this time'}
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={locked}
                    onClick={() => setScheduleStep(undefined)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid justify-items-center gap-4 py-4">
                <Tick />
                <p className="text-xl font-semibold">
                  Scheduled for {formatIstSchedule(publication?.scheduledFor ?? null)} (IST)
                </p>
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => {
                    onNotice('Scheduled.');
                    setScheduleStep(undefined);
                  }}
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function ConfirmStep({
  deal,
  locked,
  onCancel,
  onPublish,
}: {
  deal: AdminDeal;
  locked: boolean;
  onCancel: () => void;
  onPublish: () => void;
}) {
  return (
    <div>
      {deal.hasImage ? (
        <img
          src={dealImageSrc(deal.id, deal.updatedAt)}
          alt=""
          className="h-28 w-full rounded-xl object-cover sm:w-28"
        />
      ) : null}
      <p className="mt-3 text-xl font-semibold">{deal.title}</p>
      <p className="text-lg">{formatPaise(deal.price * 100)}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className={secondaryButton} disabled={locked} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={publishButton} disabled={locked} onClick={onPublish}>
          Publish now
        </button>
      </div>
    </div>
  );
}

function UncertainPanel({
  locked,
  messageId,
  onMessageId,
  onResolve,
}: {
  locked: boolean;
  messageId: string;
  onMessageId: (value: string) => void;
  onResolve: (outcome: 'posted' | 'not_posted') => void;
}) {
  const [askId, setAskId] = useState(false);
  return (
    <div className="rounded-2xl border border-amber-500 bg-amber-50 p-4">
      <p className="text-lg">We could not confirm the post. Check the channel</p>
      {askId ? (
        <label className="mt-3 block text-lg">
          Message id
          <input
            className="mt-2 min-h-14 w-full rounded-xl border-2 border-slate-400 px-4 text-lg"
            value={messageId}
            onChange={(event) => onMessageId(event.target.value)}
          />
        </label>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <button
          type="button"
          className={primaryButton}
          disabled={locked}
          onClick={() => {
            if (!askId) {
              setAskId(true);
              return;
            }
            onResolve('posted');
          }}
        >
          It was posted
        </button>
        <button
          type="button"
          className={secondaryButton}
          disabled={locked}
          onClick={() => onResolve('not_posted')}
        >
          It was not posted
        </button>
      </div>
    </div>
  );
}

function Tick() {
  return (
    <div className="flex h-24 w-24 items-center justify-center rounded-full bg-green-700 text-5xl text-white">
      ✓
    </div>
  );
}

function Cross() {
  return (
    <div className="flex h-24 w-24 items-center justify-center rounded-full bg-red-700 text-5xl text-white">
      ×
    </div>
  );
}
