import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewScreen } from '../src/components/admin/ReviewScreen';
import { STALE_DEAL, type AdminDeal } from '../src/components/admin/types';

function deal(overrides: Partial<AdminDeal> = {}): AdminDeal {
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
    highlights: ['Steel'],
    offer: 'Bank offer',
    clerkNotes: 'Found this morning',
    reviewNote: null,
    rejectedReason: null,
    previewEnabled: true,
    productUrl: 'https://www.amazon.in/dp/B0TEST1234',
    taggedUrl: 'https://www.amazon.in/dp/B0TEST1234?tag=example-21',
    shortLink: 'https://amzn.to/kettle',
    asin: 'B0TEST1234',
    image: null,
    duplicate: {
      hasActiveDeal: false,
      repost: { allowed: true, reason: 'first_post' },
    },
    preview: {
      ok: true,
      html: '<b>Blue kettle</b>',
      caption: '<b>Blue kettle</b>',
      characterCount: 18,
      warnings: ['Avoid hurry'],
      forbiddenWords: ['hurry'],
    },
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('ReviewScreen', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.style.overflow = '';
  });

  function stub(
    handler: (
      url: string,
      init?: RequestInit,
    ) => Promise<ReturnType<typeof json>> | ReturnType<typeof json>,
  ) {
    const fetchMock = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/deals/config')) {
        return json({ shortLinkHosts: ['amzn.to', 'link.amazon'] });
      }
      return handler(url, init);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('disables the verified switch until the old price is higher, and explains why', async () => {
    const user = userEvent.setup();
    stub(async () => json(deal()));
    render(<ReviewScreen initialDeal={deal({ oldPrice: null, oldPriceVerified: false })} />);
    const toggle = screen.getByRole('switch', { name: 'Old price is verified' });
    expect(toggle).toHaveProperty('disabled', true);
    expect(
      screen.getByText(
        'Turn on only if you have a real earlier price on record; it adds the % off line to the post.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Enter an old price higher than the price before marking it verified.'),
    ).toBeTruthy();

    await user.clear(screen.getByLabelText('Old price'));
    await user.type(screen.getByLabelText('Old price'), '2000');
    expect(toggle).toHaveProperty('disabled', false);
  });

  it('enables actions that match the status and keeps publishing disabled', () => {
    stub(async () => json(deal()));
    const pending = render(<ReviewScreen initialDeal={deal()} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Send back' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Reopen' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Unapprove' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /Publish now/ })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /Schedule/ })).toHaveProperty('disabled', true);
    expect(screen.getAllByText(/Publishing arrives in the next step/).length).toBe(2);
    pending.unmount();

    const approved = render(<ReviewScreen initialDeal={deal({ status: 'approved' })} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Unapprove' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveProperty('disabled', false);
    approved.unmount();

    render(<ReviewScreen initialDeal={deal({ status: 'rejected' })} />);
    expect(screen.getByRole('button', { name: 'Reopen' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Title')).toHaveProperty('disabled', true);
  });

  it('shows duplicate and repost banners', () => {
    stub(async () => json(deal()));
    render(
      <ReviewScreen
        initialDeal={deal({
          duplicate: {
            hasActiveDeal: true,
            repost: { allowed: false, reason: 'price_not_lower' },
          },
        })}
      />,
    );
    expect(screen.getByText('Another deal for this product is already in the queue.')).toBeTruthy();
    expect(
      screen.getByText(
        'This product was already posted. The new price has to be lower than the last posted price.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Avoid hurry')).toBeTruthy();
    expect(screen.getByText('18 / 900')).toBeTruthy();
  });

  it('shows the stale-save message and a reload button', async () => {
    const user = userEvent.setup();
    const reloaded = deal({
      title: 'Reloaded kettle',
      preview: { ...deal().preview, html: '<b>Reloaded kettle</b>' },
    });
    stub(async (url, init) => {
      if (init?.method === 'PATCH') {
        return json({ error: STALE_DEAL }, 409);
      }
      if (url.includes('/api/admin/deals/deal-1')) {
        return json(reloaded);
      }
      return json(deal());
    });
    render(<ReviewScreen initialDeal={deal()} />);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByRole('alert')).textContent).toContain(STALE_DEAL);
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByDisplayValue('Reloaded kettle')).toBeTruthy();
  });

  it('requires a note to send back and a reason to reject', async () => {
    const user = userEvent.setup();
    const fetchMock = stub(async () =>
      json(
        deal({
          status: 'draft',
          reviewNote: 'Please add the size.',
          preview: { ...deal().preview, html: '<b>Sent back</b>' },
        }),
      ),
    );
    render(<ReviewScreen initialDeal={deal()} />);
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Send back' }));
    expect(screen.getByRole('alert').textContent).toContain('Enter a note for the person.');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('send-back'))).toBe(false);

    await user.type(within(dialog).getByLabelText('Note'), 'Please add the size.');
    await user.click(within(dialog).getByRole('button', { name: 'Send back' }));
    expect(await screen.findByText('Sent back')).toBeTruthy();
  });

  it('asks for a reason before rejecting', async () => {
    const user = userEvent.setup();
    stub(async () => json(deal({ status: 'rejected', rejectedReason: 'Wrong product.' })));
    render(<ReviewScreen initialDeal={deal()} />);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reject this deal' }));
    expect(screen.getByRole('alert').textContent).toContain('Enter a reason.');
    await user.type(within(dialog).getByLabelText('Reason'), 'Wrong product.');
    await user.click(within(dialog).getByRole('button', { name: 'Reject this deal' }));
    expect(await screen.findByRole('button', { name: 'Reopen' })).toHaveProperty('disabled', false);
  });

  it('refreshes the server preview after save', async () => {
    const user = userEvent.setup();
    const saved = deal({
      title: 'Green kettle',
      updatedAt: '2026-11-07T11:00:00.000Z',
      preview: {
        ok: true,
        html: '<b>Green kettle</b>',
        caption: '<b>Green kettle</b>',
        characterCount: 19,
        warnings: [],
        forbiddenWords: [],
      },
    });
    stub(async (_url, init) => (init?.method === 'PATCH' ? json(saved) : json(deal())));
    render(<ReviewScreen initialDeal={deal()} />);
    expect(screen.getByTestId('post-preview').textContent).toContain('Blue kettle');
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Green kettle');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect((await screen.findByTestId('post-preview')).textContent).toContain('Green kettle');
    expect(screen.getByText('19 / 900')).toBeTruthy();
  });
});
