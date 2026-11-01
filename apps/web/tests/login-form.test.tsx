import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from '../src/components/LoginForm';

const follow = vi.fn();

vi.mock('../src/lib/navigate', () => ({
  follow: (path: string) => follow(path),
}));

describe('LoginForm', () => {
  beforeEach(() => {
    follow.mockReset();
  });

  it('shows the server error and keeps the button disabled while the request is in flight', async () => {
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

    render(<LoginForm />);
    await user.type(screen.getByLabelText('Username'), 'ada');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const pendingButton = await screen.findByRole('button', { name: 'Signing in…' });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);

    resolveFetch?.(
      new Response(JSON.stringify({ error: 'The username or password is incorrect.' }), {
        status: 401,
      }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The username or password is incorrect.',
    );
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('shows the rate-limit message politely', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: 'Too many sign-in attempts. Wait a few minutes and try again.' },
          { status: 429 },
        ),
      ),
    );

    render(<LoginForm />);
    await user.type(screen.getByLabelText('Username'), 'ada');
    await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Too many sign-in attempts. Wait a few minutes and try again.',
    );
    expect(follow).not.toHaveBeenCalled();
  });
});
