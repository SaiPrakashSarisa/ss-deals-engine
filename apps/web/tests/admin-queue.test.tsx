import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminQueue } from '../src/components/admin/AdminQueue';
import type { AdminListItem } from '../src/components/admin/types';

const search = vi.hoisted(() => ({ value: '' }));
const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => navigation,
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
    navigation.replace.mockReset();
    navigation.push.mockReset();
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

  it('versions a thumbnail and shows a confirmation once', async () => {
    search.value = 'notice=sent_back&name=Grace%20Hopper';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          counts,
          items: [item({ hasImage: true, updatedAt: '2026-11-07T10:00:00.000Z' })],
        }),
      ),
    );
    render(<AdminQueue status="pending_approval" now={now} />);
    expect(await screen.findByRole('heading', { name: 'Blue kettle' })).toBeTruthy();
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      `/api/deals/deal-1/image?v=${encodeURIComponent('2026-11-07T10:00:00.000Z')}`,
    );
    expect(screen.getByRole('status').textContent).toContain('Sent back to Grace Hopper.');
    expect(navigation.replace).toHaveBeenCalledWith('/admin');
  });

  it('lists scheduled deals by time with a status line', async () => {
    search.value = 'status=scheduled';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes('/publications')) {
          return json({
            items: [
              {
                dealId: 'later',
                scheduledFor: '2026-11-08T10:00:00.000Z',
                statusLine: 'Waiting for the minimum gap (earliest 3:30 pm)',
              },
              {
                dealId: 'sooner',
                scheduledFor: '2026-11-08T08:45:00.000Z',
                statusLine: "Waiting for tomorrow's limit",
              },
            ],
          });
        }
        return json({
          counts: { ...counts, scheduled: 2 },
          items: [
            item({ id: 'later', title: 'Later kettle', status: 'scheduled' }),
            item({ id: 'sooner', title: 'Sooner kettle', status: 'scheduled' }),
          ],
        });
      }),
    );
    render(<AdminQueue status="scheduled" now={now} />);
    const sooner = await screen.findByRole('heading', { name: 'Sooner kettle' });
    const later = screen.getByRole('heading', { name: 'Later kettle' });
    expect(sooner.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Waiting for tomorrow's limit")).toBeTruthy();
    expect(screen.getAllByText(/Scheduled for/)).toHaveLength(2);
    const card = screen
      .getAllByRole('link', { name: /Scheduled/ })
      .find((link) => within(link).queryByText('2'));
    expect(card).toBeDefined();
  });
});
