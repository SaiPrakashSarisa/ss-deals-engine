import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewScreen } from '../src/components/admin/ReviewScreen';
import { STALE_DEAL, type AdminDeal } from '../src/components/admin/types';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => navigation,
}));

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
    navigation.push.mockReset();
    navigation.replace.mockReset();
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
    expect(screen.getByRole('button', { name: 'Publish now' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Schedule' })).toHaveProperty('disabled', true);
    pending.unmount();

    const approved = render(<ReviewScreen initialDeal={deal({ status: 'approved' })} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Unapprove' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Publish now' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Schedule' })).toHaveProperty('disabled', false);
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
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith('/admin?notice=sent_back&name=Grace%20Hopper');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
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
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith('/admin?notice=rejected');
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Review deal' })).toBeTruthy();
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

  it('stays after approve, keeps the new time, and leaves after a failed action', async () => {
    const user = userEvent.setup();
    const approved = deal({ status: 'approved', updatedAt: '2026-11-07T12:00:00.000Z' });
    const bodies: string[] = [];
    stub(async (url, init) => {
      if (String(url).endsWith('/approve')) {
        bodies.push(String(init?.body));
        return json(approved);
      }
      if (String(url).endsWith('/unapprove')) {
        bodies.push(String(init?.body));
        return json(deal({ updatedAt: '2026-11-07T12:30:00.000Z' }));
      }
      return json({ error: 'This deal was withdrawn or changed.' }, 409);
    });
    render(<ReviewScreen initialDeal={deal()} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Unapprove' })).toHaveProperty('disabled', false);
    expect(navigation.push).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Unapprove' }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[0]).toContain(deal().updatedAt);
    expect(bodies[1]).toContain(approved.updatedAt);
    expect(navigation.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await user.type(screen.getByLabelText('Reason'), 'Wrong product.');
    await user.click(screen.getByRole('button', { name: 'Reject this deal' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This deal was withdrawn or changed.',
    );
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('disables the actions while one is still running', async () => {
    const user = userEvent.setup();
    let release: (value: ReturnType<typeof json>) => void = () => undefined;
    const gate = new Promise<ReturnType<typeof json>>((resolve) => {
      release = resolve;
    });
    stub(async (url) => (String(url).endsWith('/approve') ? gate : json(deal())));
    render(<ReviewScreen initialDeal={deal()} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Approve' })).toHaveProperty('disabled', true);
    });
    expect(screen.getByRole('button', { name: 'Send back' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveProperty('disabled', true);
    release(json(deal({ status: 'approved', updatedAt: '2026-11-07T12:00:00.000Z' })));
    expect(await screen.findByText('Approved.')).toBeTruthy();
  });

  it('shows the new image immediately and the placeholder after remove', async () => {
    const user = userEvent.setup();
    const first = '2026-11-07T10:00:00.000Z';
    const second = '2026-11-07T11:00:00.000Z';
    const third = '2026-11-07T11:05:00.000Z';
    stub(async (url, init) => {
      if (init?.method === 'POST' && String(url).endsWith('/image')) {
        return json(
          deal({
            hasImage: true,
            updatedAt: second,
            preview: { ...deal().preview, html: '<b>With photo</b>' },
          }),
        );
      }
      if (init?.method === 'DELETE') {
        return json(deal({ hasImage: false, updatedAt: third }));
      }
      return json(deal());
    });
    render(<ReviewScreen initialDeal={deal({ hasImage: true, updatedAt: first })} />);
    expect(
      screen
        .getAllByRole('img')
        .every((img) => img.getAttribute('src')?.includes(encodeURIComponent(first))),
    ).toBe(true);
    await user.upload(
      screen.getByLabelText('Replace'),
      new File(['photo'], 'photo.png', { type: 'image/png' }),
    );
    await waitFor(() => {
      expect(
        screen
          .getAllByRole('img')
          .every((img) => img.getAttribute('src')?.includes(encodeURIComponent(second))),
      ).toBe(true);
    });
    expect(screen.getByTestId('post-preview').textContent).toContain('With photo');
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(screen.queryAllByRole('img')).toHaveLength(0);
    });
    expect(screen.getAllByText('No image').length).toBeGreaterThan(0);
  });

  it('shows a loading state and keeps the current image when a replace fails', async () => {
    const user = userEvent.setup();
    const first = '2026-11-07T10:00:00.000Z';
    let release: (value: ReturnType<typeof json>) => void = () => undefined;
    const gate = new Promise<ReturnType<typeof json>>((resolve) => {
      release = resolve;
    });
    stub(async (url, init) =>
      init?.method === 'POST' && String(url).endsWith('/image')
        ? gate
        : json(deal({ hasImage: true, updatedAt: first })),
    );
    render(<ReviewScreen initialDeal={deal({ hasImage: true, updatedAt: first })} />);
    await user.upload(
      screen.getByLabelText('Replace'),
      new File(['bad'], 'bad.png', { type: 'image/png' }),
    );
    expect(await screen.findByText('Saving image…')).toBeTruthy();
    expect(screen.getByLabelText('Replace')).toHaveProperty('disabled', true);
    release(json({ error: 'The image could not be saved.' }, 400));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The image could not be saved.',
    );
    expect(
      screen
        .getAllByRole('img')
        .every((img) => img.getAttribute('src')?.includes(encodeURIComponent(first))),
    ).toBe(true);
  });
});
