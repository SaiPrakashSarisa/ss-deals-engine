import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppShell } from '../src/components/AppShell';

describe('role navigation', () => {
  it('shows the owner both sections, their name, and log out', () => {
    render(<AppShell user={{ id: '1', username: 'ada', role: 'owner' }} />);

    expect(screen.getByText('ada')).toBeTruthy();
    expect(screen.getByText('Owner')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Review queue' }).getAttribute('href')).toBe('/owner');
    expect(screen.getByRole('link', { name: 'New deal' }).getAttribute('href')).toBe('/clerk');
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
  });

  it('hides the owner section from a clerk', () => {
    render(<AppShell user={{ id: '2', username: 'grace', role: 'clerk' }} />);

    expect(screen.getByText('grace')).toBeTruthy();
    expect(screen.getByText('Clerk')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Review queue' })).toBeNull();
    expect(screen.getByRole('link', { name: 'New deal' }).getAttribute('href')).toBe('/clerk');
  });
});
