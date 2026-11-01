import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../src/components/AppShell';

const owner = { id: '1', username: 'ada', displayName: 'Ada Lovelace', role: 'owner' as const };
const other = { id: '2', username: 'grace', displayName: 'Grace Hopper', role: 'clerk' as const };

describe('role navigation', () => {
  it('shows an admin their name, the Admin label, and both sections', () => {
    render(<AppShell user={owner} />);

    expect(screen.getByText('Ada Lovelace')).toBeTruthy();
    expect(screen.queryByText('ada')).toBeNull();
    expect(screen.getByText('Admin')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review queue' }).getAttribute('href')).toBe('/admin');
    expect(screen.getByRole('link', { name: 'New deal' }).getAttribute('href')).toBe('/deals/new');
    expect(screen.queryByRole('link', { name: 'My deals' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Account' }).getAttribute('href')).toBe('/account');
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
    expect(screen.queryByText(/owner/i)).toBeNull();
    expect(screen.queryByText(/clerk/i)).toBeNull();
  });

  it('shows other people their name, no role label, New deal, and My deals', () => {
    render(<AppShell user={other} />);

    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(screen.queryByText('Admin')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Review queue' })).toBeNull();
    expect(screen.getByRole('link', { name: 'New deal' }).getAttribute('href')).toBe('/deals/new');
    expect(screen.getByRole('link', { name: 'My deals' }).getAttribute('href')).toBe('/deals/mine');
    expect(screen.queryByText(/owner/i)).toBeNull();
    expect(screen.queryByText(/clerk/i)).toBeNull();
  });

  it('falls back to the username when that is the name on screen', () => {
    render(<AppShell user={{ ...other, displayName: 'grace' }} />);
    expect(screen.getByText('grace')).toBeTruthy();
    expect(screen.queryByText('Admin')).toBeNull();
  });
});
