import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminQueue } from '../src/components/admin/AdminQueue';
import type { AdminListItem } from '../src/components/admin/types';

const search = vi.hoisted(() => ({ value: '' }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));

const now = Date.parse('2026-11-07T12:00:00.000Z');

const counts = {
  pending_approval: 2,
  approved: 1,
  draft: 4,
  sent_back: 1,
  published: 4,
  rejected: 0,
  scheduled: 0,
  failed: 0,
};

function item(overrides: Partial<AdminListItem> = {}): AdminListItem {
  return {
    id: 'deal-1',
    title: 'Blue kettle',
    price: 1499,
    oldPrice: 1999,
    oldPriceVerified: false,
    hasImage: false,
    createdBy: 'Grace Hopper',
    sourceNote: 'Morning group',
    submittedAt: '2026-11-07T10:00:00.000Z',
    status: 'pending_approval',
    updatedAt: '2026-11-07T10:00:00.000Z',
    ...overrides,
  };
}

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

describe('AdminQueue', () => {
  afterEach(() => {
    search.value = '';
    vi.unstubAllGlobals();
  });

  it('shows counts, the oldest waiting card, and an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes('status=approved')) {
          return json({ counts, items: [] });
        }
        return json({ counts, items: [item()] });
      }),
    );

    const waiting = render(<AdminQueue status="pending_approval" now={now} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect((await screen.findByRole('link', { name: 'Review' })).getAttribute('href')).toBe(
      '/admin/deals/deal-1',
    );
    const card = screen
      .getAllByRole('link', { name: /Waiting for review/ })
      .find((link) => within(link).queryByText('2'));
    expect(card).toBeDefined();
    expect(within(card!).getByText('2')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Blue kettle' })).toBeTruthy();
    expect(screen.getByText('Grace Hopper')).toBeTruthy();
    expect(screen.getByText('Morning group')).toBeTruthy();
    expect(screen.getByText('2 hr ago')).toBeTruthy();
    expect(screen.getByText('No image')).toBeTruthy();
    waiting.unmount();

    render(<AdminQueue status="approved" now={now} />);
    expect(await screen.findByText('No deals in this list.')).toBeTruthy();
    expect(
      screen
        .getAllByRole('link', { name: /Posted/ })
        .some((link) => link.getAttribute('href') === '/admin?status=published'),
    ).toBe(true);
  });

  it('shows an error state when the queue cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'nope' }, false)),
    );
    render(<AdminQueue status="pending_approval" now={now} />);
    expect(await screen.findByText('The review queue could not be loaded.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('uses the sent-back count and does not list never-submitted drafts', async () => {
    search.value = 'status=sent_back';
    let called = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        called = String(input);
        return json({
          counts,
          items: [item({ id: 'sent-1', title: 'Needs a size', status: 'draft' })],
        });
      }),
    );
    render(<AdminQueue status="pending_approval" now={now} />);
    expect(await screen.findByRole('heading', { name: 'Needs a size' })).toBeTruthy();
    expect(called).toContain('status=sent_back');
    expect(called).not.toContain('status=draft');
    const card = screen
      .getAllByRole('link', { name: /Sent back/ })
      .find(
        (link) =>
          link.getAttribute('href') === '/admin?status=sent_back' && within(link).queryByText('1'),
      );
    expect(card).toBeDefined();
    expect(within(card!).queryByText('4')).toBeNull();
  });
});
