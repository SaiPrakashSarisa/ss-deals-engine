'use client';

import { useState, type FormEvent } from 'react';

const FALLBACK_ERROR = 'The password could not be changed. Try again.';
const RATE_LIMIT_FALLBACK = 'Too many attempts. Wait a few minutes and try again.';
const SUCCESS = 'Password changed. Other sessions were signed out.';

export function ChangePasswordForm() {
  const [error, setError] = useState<string | undefined>();
  const [success, setSuccess] = useState<string | undefined>();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const currentPassword = String(new FormData(form).get('currentPassword') ?? '');
    const newPassword = String(new FormData(form).get('newPassword') ?? '');
    const repeated = String(new FormData(form).get('repeatedPassword') ?? '');
    setError(undefined);
    setSuccess(undefined);
    if (newPassword !== repeated) {
      setError('The new passwords do not match.');
      return;
    }

    setPending(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (response.status === 429) {
        setError(typeof body?.error === 'string' ? body.error : RATE_LIMIT_FALLBACK);
        return;
      }
      if (!response.ok) {
        setError(typeof body?.error === 'string' ? body.error : FALLBACK_ERROR);
        return;
      }
      form.reset();
      setSuccess(SUCCESS);
    } catch {
      setError(FALLBACK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-5" onSubmit={(event) => void onSubmit(event)}>
      <PasswordField id="currentPassword" name="currentPassword" label="Current password" />
      <PasswordField
        id="newPassword"
        name="newPassword"
        label="New password"
        autoComplete="new-password"
      />
      <PasswordField
        id="repeatedPassword"
        name="repeatedPassword"
        label="Repeat new password"
        autoComplete="new-password"
      />
      {error !== undefined ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-lg text-red-900" role="alert">
          {error}
        </p>
      ) : null}
      {success !== undefined ? (
        <p className="rounded-xl bg-teal-50 px-4 py-3 text-lg text-teal-950" role="status">
          {success}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="min-h-14 rounded-xl bg-primary text-lg font-semibold text-white disabled:opacity-60"
      >
        {pending ? 'Saving…' : 'Change password'}
      </button>
    </form>
  );
}

function PasswordField({
  id,
  name,
  label,
  autoComplete = 'current-password',
}: {
  id: string;
  name: string;
  label: string;
  autoComplete?: string;
}) {
  return (
    <div className="grid gap-2">
      <label className="text-lg font-semibold" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="password"
        autoComplete={autoComplete}
        required
        className="min-h-14 rounded-xl border-2 border-slate-400 bg-white px-4 text-lg text-ink"
      />
    </div>
  );
}
