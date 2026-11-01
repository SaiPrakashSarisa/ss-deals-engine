'use client';

import { useState } from 'react';
import { follow } from '../lib/navigate';

export function LogoutButton() {
  const [pending, setPending] = useState(false);

  async function logout(): Promise<void> {
    setPending(true);
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST' });
      if (response.ok) {
        follow('/login');
        return;
      }
    } catch {
      // Leave the person on the page so they can try again.
    }
    setPending(false);
  }

  return (
    <button
      type="button"
      onClick={() => void logout()}
      disabled={pending}
      className="min-h-12 rounded-xl border-2 border-primary px-4 text-lg font-semibold text-primary disabled:opacity-60"
    >
      {pending ? 'Signing out…' : 'Log out'}
    </button>
  );
}
