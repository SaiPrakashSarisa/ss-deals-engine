import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChangePasswordForm } from '../src/components/ChangePasswordForm';

describe('ChangePasswordForm', () => {
  it('keeps the button disabled while the request is in flight and shows success', async () => {
    const user = userEvent.setup();
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    render(<ChangePasswordForm />);
    await user.type(screen.getByLabelText('Current password'), 'correct-horse-battery');
    await user.type(screen.getByLabelText('New password'), 'another-horse-battery');
    await user.type(screen.getByLabelText('Repeat new password'), 'another-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('button', { name: 'Saving…' })).toHaveProperty('disabled', true);
    resolveFetch?.(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'Password changed. Other sessions were signed out.',
    );
  });

  it('shows a mismatch without calling the server', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ChangePasswordForm />);
    await user.type(screen.getByLabelText('Current password'), 'correct-horse-battery');
    await user.type(screen.getByLabelText('New password'), 'another-horse-battery');
    await user.type(screen.getByLabelText('Repeat new password'), 'different-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect((await screen.findByRole('alert')).textContent).toBe('The new passwords do not match.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the wait message when too many attempts come back', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Too many attempts. Wait a few minutes and try again.' },
          { status: 429 },
        ),
      ),
    );

    render(<ChangePasswordForm />);
    await user.type(screen.getByLabelText('Current password'), 'correct-horse-battery');
    await user.type(screen.getByLabelText('New password'), 'another-horse-battery');
    await user.type(screen.getByLabelText('Repeat new password'), 'another-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many attempts. Wait a few minutes and try again.',
    );
  });
});
