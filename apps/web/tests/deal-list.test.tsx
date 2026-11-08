import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DealList, type ListedDeal } from '../src/components/deals/DealList';

const follow = vi.fn();

vi.mock('../src/lib/navigate', () => ({
  follow: (path: string) => follow(path),
}));

const hosts = ['amzn.to', 'link.amazon'];

function deal(overrides: Partial<ListedDeal> = {}): ListedDeal {
  return {
    id: 'deal-1',
    title: 'Blue kettle',
    status: 'draft',
    pricePaise: 149_900,
    oldPricePaise: 200_000,
    highlights: ['Steel'],
    offer: 'Bank offer',
    shortLink: 'https://amzn.to/kettle1',
    taggedUrl: 'https://www.amazon.in/dp/B0TEST1234?tag=example-21',
    productUrl: 'https://www.amazon.in/dp/B0TEST1234',
    reviewNote: 'Please check the title',
    rejectedReason: null,
    hasImage: false,
    ...overrides,
  };
}

describe('DealList', () => {
  afterEach(() => {
    follow.mockReset();
    document.body.style.overflow = '';
    vi.unstubAllGlobals();
  });

  it('opens a preview of the formatted post and closes it from the button, Escape, and the backdrop', async () => {
    const user = userEvent.setup();
    render(
      <DealList
        deals={[deal(), deal({ id: 'deal-2', status: 'published', title: 'Posted' })]}
        shortLinkHosts={hosts}
      />,
    );
    const previewButton = screen.getAllByRole('button', { name: 'Preview' })[0];
    expect(previewButton).toBeTruthy();
    await user.click(previewButton!);
    const dialog = screen.getByRole('dialog');
    expect(document.body.style.overflow).toBe('hidden');
    expect(within(dialog).getByText('No image')).toBeTruthy();
    expect(within(dialog).getByText('Preview - the admin may change it')).toBeTruthy();
    expect(within(dialog).getByText('Please check the title')).toBeTruthy();
    expect(dialog.textContent).toContain('Blue kettle');
    expect(dialog.textContent).toContain('Deal Price');
    expect(dialog.textContent).toContain('1,499');
    expect(dialog.textContent).toContain('Listed at');
    expect(dialog.textContent).toContain('Steel');
    expect(dialog.textContent).toContain('https://amzn.to/kettle1');
    expect(within(dialog).getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      '/deals/deal-1/edit',
    );
    expect(screen.getAllByRole('link', { name: 'Edit' })).toHaveLength(2);
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/clerk|\bowner\b/);

    const close = within(dialog).getByRole('button', { name: 'Close' });
    close.focus();
    await user.tab();
    expect(document.activeElement).toBe(within(dialog).getByRole('link', { name: 'Edit' }));

    await user.click(close);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(previewButton);

    await user.click(previewButton!);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(previewButton);

    await user.click(previewButton!);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(previewButton);
  });

  it('asks before withdrawing a deal that is waiting for review', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/withdraw') && init?.method === 'POST') {
        return Response.json({ deal: { id: 'deal-2', status: 'draft' } });
      }
      return Response.json({ deals: [] });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <DealList
        deals={[
          deal(),
          deal({
            id: 'deal-2',
            title: 'Waiting kettle',
            status: 'pending_approval',
            reviewNote: null,
          }),
        ]}
        shortLinkHosts={hosts}
      />,
    );

    await user.click(screen.getAllByRole('button', { name: 'Preview' })[1]!);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Edit' }));
    expect(
      screen.getByText(
        'This deal will leave the review queue. You can send it again after editing.',
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(follow).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Withdraw and edit' }));
    expect(follow).toHaveBeenCalledWith('/deals/deal-2/edit');
  });

  it('shows that the deal was already reviewed and refreshes the list', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/withdraw') && init?.method === 'POST') {
          return Response.json({ error: 'This deal was already reviewed.' }, { status: 409 });
        }
        return Response.json({
          deals: [
            deal({ id: 'deal-2', title: 'Waiting kettle', status: 'approved', reviewNote: null }),
          ],
        });
      }),
    );
    render(
      <DealList
        deals={[
          deal({
            id: 'deal-2',
            title: 'Waiting kettle',
            status: 'pending_approval',
            reviewNote: null,
          }),
        ]}
        shortLinkHosts={hosts}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Withdraw and edit' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This deal was already reviewed.');
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('versions the preview image with the deal time', async () => {
    const user = userEvent.setup();
    const updatedAt = '2026-11-07T10:00:00.000Z';
    render(<DealList deals={[deal({ hasImage: true, updatedAt })]} shortLinkHosts={hosts} />);
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    expect(within(screen.getByRole('dialog')).getByRole('img').getAttribute('src')).toBe(
      `/api/deals/deal-1/image?v=${encodeURIComponent(updatedAt)}`,
    );
  });
});
