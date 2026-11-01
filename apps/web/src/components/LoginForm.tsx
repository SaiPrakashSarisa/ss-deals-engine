'use client';

import { useState, type FormEvent } from 'react';
import { follow } from '../lib/navigate';

const FALLBACK_ERROR = 'Sign-in failed. Try again.';
const RATE_LIMIT_FALLBACK = 'Too many sign-in attempts. Wait a few minutes and try again.';

export function LoginForm() {
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const username = String(new FormData(form).get('username') ?? '');
    const password = String(new FormData(form).get('password') ?? '');
    setPending(true);
    setError(undefined);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        user?: { role?: string };
      } | null;
      if (response.status === 429) {
        setError(typeof body?.error === 'string' ? body.error : RATE_LIMIT_FALLBACK);
        return;
      }
      if (!response.ok) {
        setError(typeof body?.error === 'string' ? body.error : FALLBACK_ERROR);
        return;
      }
      follow(body?.user?.role === 'owner' ? '/owner' : '/clerk');
    } catch {
      setError(FALLBACK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-5" onSubmit={(event) => void onSubmit(event)}>
      <div className="grid gap-2">
        <label className="text-lg font-semibold" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          className="min-h-14 rounded-xl border-2 border-slate-400 bg-white px-4 text-lg text-ink"
        />
      </div>
      <div className="grid gap-2">
        <label className="text-lg font-semibold" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="min-h-14 rounded-xl border-2 border-slate-400 bg-white px-4 text-lg text-ink"
        />
      </div>
      {error !== undefined ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-lg text-red-900" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="min-h-14 rounded-xl bg-primary text-lg font-semibold text-white disabled:opacity-60"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
