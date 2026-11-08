'use client';

import { useEffect, useState } from 'react';
import { formatIst } from './ist';
import type { PublicationItem, PublishingStatus } from './types';

const buttonClass =
  'inline-flex min-h-14 items-center justify-center rounded-xl border-2 border-primary px-5 text-lg font-semibold text-primary disabled:opacity-60';
const primaryButton =
  'inline-flex min-h-14 items-center justify-center rounded-xl bg-primary px-5 text-lg font-semibold text-white disabled:opacity-60';
const fieldClass = 'min-h-14 w-full rounded-xl border-2 border-slate-400 bg-white px-4 text-lg';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'queued', label: 'Queued' },
  { value: 'publishing', label: 'Publishing' },
  { value: 'published', label: 'Posted' },
  { value: 'failed', label: 'Failed' },
  { value: 'uncertain', label: 'Uncertain' },
];

export function PublishingDesk() {
  const [status, setStatus] = useState<PublishingStatus | undefined>();
  const [items, setItems] = useState<PublicationItem[]>([]);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<string | undefined>();
  const [dailyLimit, setDailyLimit] = useState('8');
  const [minGapMinutes, setMinGapMinutes] = useState('30');

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(undefined);
    const query = new URLSearchParams({ page: String(page), pageSize: '20' });
    if (filter !== '') {
      query.set('status', filter);
    }
    void Promise.all([
      fetch('/api/admin/publishing/status'),
      fetch(`/api/admin/publications?${query.toString()}`),
    ])
      .then(async ([statusResponse, listResponse]) => {
        if (cancel) {
          return;
        }
        if (!statusResponse.ok || !listResponse.ok) {
          setError('Publishing could not be loaded.');
          return;
        }
        const next = (await statusResponse.json()) as PublishingStatus;
        const list = (await listResponse.json()) as { items?: PublicationItem[] };
        setStatus(next);
        setDailyLimit(String(next.dailyLimit));
        if (typeof next.minGapMinutes === 'number') {
          setMinGapMinutes(String(next.minGapMinutes));
        }
        setItems(list.items ?? []);
      })
      .catch(() => {
        if (!cancel) {
          setError('Publishing could not be loaded.');
        }
      })
      .finally(() => {
        if (!cancel) {
          setLoading(false);
        }
      });
    return () => {
      cancel = true;
    };
  }, [filter, page]);

  async function command(
    name: string,
    path: string,
    method: 'POST' | 'PATCH',
    body?: unknown,
  ): Promise<void> {
    setPending(name);
    setError(undefined);
    try {
      const response = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? 'That change could not be saved.');
        return;
      }
      const next = (await response.json()) as PublishingStatus;
      setStatus(next);
      setDailyLimit(String(next.dailyLimit));
      if (typeof next.minGapMinutes === 'number') {
        setMinGapMinutes(String(next.minGapMinutes));
      }
    } catch {
      setError('That change could not be saved.');
    } finally {
      setPending(undefined);
    }
  }

  if (loading && status === undefined) {
    return <p className="text-lg">Loading…</p>;
  }
  if (error !== undefined && status === undefined) {
    return (
      <p className="text-lg" role="alert">
        {error}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section
        className="rounded-2xl border border-line bg-white p-4"
        aria-label="Publishing status"
      >
        <h1 className="text-3xl font-bold">Publishing</h1>
        <p className="mt-3 text-lg">
          {status?.enabled ? 'Publishing is on.' : 'Publishing is off.'}
        </p>
        <p className="text-lg">{status?.paused ? 'Paused.' : 'Running.'}</p>
        <p className="text-lg">
          Posted today: {status?.postedToday ?? 0} of {status?.dailyLimit ?? 0}
        </p>
        <p className="text-lg">
          Next scheduled: {status?.nextScheduled ? formatIst(status.nextScheduled) : 'None'}
        </p>
        <p className="text-lg">Uncertain: {status?.uncertain ?? 0}</p>
        {status?.channel ? <p className="text-lg">Channel: {status.channel}</p> : null}
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={pending !== undefined || status?.paused === true}
            onClick={() => void command('pause', '/api/admin/publishing/pause', 'POST')}
          >
            {pending === 'pause' ? 'Pausing…' : 'Pause'}
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={pending !== undefined || status?.paused !== true}
            onClick={() => void command('resume', '/api/admin/publishing/resume', 'POST')}
          >
            {pending === 'resume' ? 'Resuming…' : 'Resume'}
          </button>
        </div>
        <form
          className="mt-4 grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void command('settings', '/api/admin/publishing/settings', 'PATCH', {
              dailyLimit: Number(dailyLimit),
              minGapMinutes: Number(minGapMinutes),
            });
          }}
        >
          <label className="text-lg font-semibold">
            Daily limit
            <input
              className={`${fieldClass} mt-2`}
              inputMode="numeric"
              value={dailyLimit}
              onChange={(event) => setDailyLimit(event.target.value)}
            />
          </label>
          <label className="text-lg font-semibold">
            Minimum gap in minutes
            <input
              className={`${fieldClass} mt-2`}
              inputMode="numeric"
              value={minGapMinutes}
              onChange={(event) => setMinGapMinutes(event.target.value)}
            />
          </label>
          <button type="submit" className={primaryButton} disabled={pending !== undefined}>
            {pending === 'settings' ? 'Saving…' : 'Save settings'}
          </button>
        </form>
        {error ? (
          <p className="mt-3 text-lg" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      <section aria-label="Post history">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-bold">History</h2>
          <label className="text-lg">
            Status
            <select
              className={`${fieldClass} ml-2`}
              value={filter}
              onChange={(event) => {
                setPage(1);
                setFilter(event.target.value);
              }}
            >
              {FILTERS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading ? <p className="mt-3 text-lg">Loading…</p> : null}
        {!loading && items.length === 0 ? <p className="mt-3 text-lg">No posts yet.</p> : null}
        {items.length > 0 ? (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-left text-lg">
              <thead>
                <tr>
                  <th className="border-b border-line p-3">Time</th>
                  <th className="border-b border-line p-3">Title</th>
                  <th className="border-b border-line p-3">Status</th>
                  <th className="border-b border-line p-3">Error</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td className="border-b border-line p-3">
                      {formatIst(item.publishedAt ?? item.scheduledFor ?? item.createdAt)}
                    </td>
                    <td className="border-b border-line p-3">
                      {item.title}
                      {item.origin === 'quickpost_import' ? ' Imported' : ''}
                    </td>
                    <td className="border-b border-line p-3">{item.status}</td>
                    <td className="border-b border-line p-3">{item.lastError ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-3">
          <button
            type="button"
            className={buttonClass}
            disabled={page === 1 || pending !== undefined}
            onClick={() => setPage((current) => current - 1)}
          >
            Previous
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={items.length < 20 || pending !== undefined}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </button>
        </div>
      </section>
    </div>
  );
}
