import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DealForm } from '../src/components/deals/DealForm';

const follow = vi.fn();

vi.mock('../src/lib/navigate', () => ({
  follow: (path: string) => follow(path),
}));

const taggedUrl = 'https://www.amazon.in/dp/B0TEST1234?tag=example-21';

function checkResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    asin: 'B0TEST1234',
    problems: [],
    code: 'ok',
    activeDeal: false,
    repost: { allowed: true, reason: 'first_post' },
    previousPricePaise: null,
    newPricePaise: null,
    taggedUrl,
    ...overrides,
  };
}

describe('DealForm', () => {
  afterEach(() => {
    follow.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('marks the required fields and does not use role words', () => {
    render(<DealForm />);
    expect(
      screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === '* required'),
    ).toBeTruthy();
    for (const name of [/^Product page URL/, /^Title/, /^Price/]) {
      const input = screen.getByLabelText(name) as HTMLInputElement;
      expect(input.labels?.[0]?.querySelector('.text-red-600')?.textContent?.trim()).toBe('*');
    }
    const oldPrice = screen.getByLabelText(/^Old price/) as HTMLInputElement;
    expect(oldPrice.labels?.[0]?.querySelector('.text-red-600')).toBeNull();
    expect(screen.getByText('Paste the product page link from the address bar')).toBeTruthy();
    expect(screen.getByText(/SiteStripe/)).toBeTruthy();
    expect(screen.getByText('Preview - an admin may change it')).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/clerk|\bowner\b/);
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: 'Send for review' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows field errors, parses a pasted price, and previews an unverified old price', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(checkResponse({ newPricePaise: 149_900 }))),
    );
    render(<DealForm />);

    await user.click(screen.getByLabelText(/^Product page URL/));
    await user.paste('https://www.amazon.in/dp/B0TEST1234');
    expect(await screen.findByText('OK')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Enter a title.')).toBeTruthy();
    expect(screen.getByText('Enter the price in whole rupees.')).toBeTruthy();

    await user.type(screen.getByLabelText(/^Title/), 'Blue kettle');
    await user.click(screen.getByLabelText(/^Price/));
    await user.paste('₹1,499');
    expect((screen.getByLabelText(/^Price/) as HTMLInputElement).value).toBe('1499');
    await user.click(screen.getByLabelText(/^Old price/));
    await user.paste('₹2,000');
    expect(await screen.findByText(/Listed at/)).toBeTruthy();
    expect(document.body.textContent).toContain('1,499');
    expect(document.body.textContent).toContain('2,000');
    expect(document.body.textContent).not.toContain('% off');
  });

  it('shows the queue, posted, and lower-price banners and disables saving when blocked', async () => {
    const user = userEvent.setup();
    const responses = [
      checkResponse({ code: 'in_queue', activeDeal: true }),
      checkResponse({
        code: 'posted_blocked',
        previousPricePaise: 199_900,
        newPricePaise: 199_900,
        repost: { allowed: false, reason: 'price_not_lower' },
      }),
      checkResponse({
        code: 'posted_lower',
        previousPricePaise: 199_900,
        newPricePaise: 149_900,
        repost: { allowed: true, reason: 'price_lower' },
      }),
    ];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/config')) {
          return Response.json({ shortLinkHosts: ['amzn.to', 'link.amazon'], maxUploadMb: 5 });
        }
        return Response.json(responses[Math.min(call++, responses.length - 1)]!);
      }),
    );
    render(<DealForm />);
    const url = screen.getByLabelText(/^Product page URL/);

    await user.click(url);
    await user.paste('https://www.amazon.in/dp/B0TEST1234');
    expect(await screen.findByText('Already in the queue')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.clear(url);
    await user.paste('https://www.amazon.in/dp/B0TEST5678');
    expect(await screen.findByText('Already posted')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Send for review' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await user.clear(url);
    await user.paste('https://www.amazon.in/dp/B0TEST0001');
    expect(
      await screen.findByText(/Posted before; allowed because the price is lower/),
    ).toBeTruthy();
    expect(document.body.textContent).toContain('₹1,999');
    expect(document.body.textContent).toContain('₹1,499');
    expect((screen.getByRole('button', { name: 'Save draft' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('sends a complete deal for review', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith('/config')) {
          return Response.json({ shortLinkHosts: ['amzn.to', 'link.amazon'], maxUploadMb: 5 });
        }
        if (path.endsWith('/check-url')) {
          return Response.json(checkResponse());
        }
        if (path.endsWith('/api/deals') && init?.method === 'POST') {
          return Response.json({ deal: { id: 'deal-1' } });
        }
        if (path.endsWith('/submit')) {
          return Response.json({ deal: { id: 'deal-1', status: 'pending_approval' } });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    );
    render(<DealForm />);
    await user.type(screen.getByLabelText(/^Title/), 'Blue kettle');
    await user.click(screen.getByLabelText(/^Price/));
    await user.paste('1499');
    await user.click(screen.getByLabelText(/^Product page URL/));
    await user.paste('https://www.amazon.in/dp/B0TEST1234');
    expect(await screen.findByText('OK')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send for review' }));
    await waitFor(() => {
      expect(follow).toHaveBeenCalledWith('/deals/mine');
    });
  });

  it('previews a chosen image and removes it', async () => {
    const user = userEvent.setup();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    render(<DealForm />);
    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Image'), file);
    expect(screen.getByRole('img', { name: 'Chosen image' }).getAttribute('src')).toBe(
      'blob:preview',
    );
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('img', { name: 'Chosen image' })).toBeNull();
  });

  it('prefills an editable deal, shows the editing banner, and keeps the product link read-only', async () => {
    const user = userEvent.setup();
    const requests: { url: string; body?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url);
        requests.push({ url: path, body: typeof init?.body === 'string' ? init.body : undefined });
        if (path.endsWith('/config')) {
          return Response.json({ shortLinkHosts: ['amzn.to', 'link.amazon'], maxUploadMb: 5 });
        }
        if (path.endsWith('/check-url')) {
          return Response.json(checkResponse({ code: 'editing' }));
        }
        if (path.endsWith('/deal-1') && (init?.method === undefined || init.method === 'GET')) {
          return Response.json({
            deal: {
              title: 'Blue kettle',
              productUrl: 'https://www.amazon.in/dp/B0TEST1234',
              taggedUrl,
              pricePaise: 149_900,
              oldPricePaise: 200_000,
              highlights: ['Steel', '1.5 L'],
              offer: 'Bank offer',
              shortLink: 'https://amzn.to/kettle1',
              sourceNote: 'Deals group',
              clerkNotes: 'Looks good',
              hasImage: true,
              status: 'draft',
              editable: true,
            },
          });
        }
        if (path.endsWith('/deal-1') && init?.method === 'PATCH') {
          return Response.json({ deal: { id: 'deal-1' } });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    );

    render(<DealForm mode="edit" dealId="deal-1" />);
    expect(await screen.findByRole('heading', { name: 'Edit deal' })).toBeTruthy();
    expect((screen.getByLabelText(/^Title/) as HTMLInputElement).value).toBe('Blue kettle');
    expect((screen.getByLabelText(/^Price/) as HTMLInputElement).value).toBe('1499');
    expect((screen.getByLabelText(/^Old price/) as HTMLInputElement).value).toBe('2000');
    expect((screen.getByLabelText(/^Offer/) as HTMLInputElement).value).toBe('Bank offer');
    expect((screen.getByLabelText('Highlight 1') as HTMLInputElement).value).toBe('Steel');
    expect((screen.getByLabelText('Found in group') as HTMLInputElement).value).toBe('Deals group');
    expect((screen.getByLabelText('Notes') as HTMLInputElement).value).toBe('Looks good');
    const productUrl = screen.getByLabelText(/^Product page URL/) as HTMLInputElement;
    expect(productUrl.value).toBe('https://www.amazon.in/dp/B0TEST1234');
    expect(productUrl.readOnly).toBe(true);
    expect(screen.getByText('To use a different product, start a new deal.')).toBeTruthy();
    expect(await screen.findByText('Editing your deal')).toBeTruthy();
    expect(screen.queryByText('Already in the queue')).toBeNull();
    expect(screen.getByRole('img', { name: 'Deal image' }).getAttribute('src')).toBe(
      '/api/deals/deal-1/image',
    );
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toMatch(/clerk|\bowner\b/);
    const check = requests.find((request) => request.url.endsWith('/check-url'));
    expect(check?.body).toContain('"dealId":"deal-1"');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeTruthy();
    expect(follow).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Edit deal' })).toBeTruthy();
  });

  it('shows a clear page when the deal cannot be edited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/config')) {
          return Response.json({ shortLinkHosts: ['amzn.to'], maxUploadMb: 5 });
        }
        return Response.json({ error: 'That deal was not found.' }, { status: 404 });
      }),
    );
    render(<DealForm mode="edit" dealId="deal-9" />);
    expect(await screen.findByRole('heading', { name: "You can't edit this deal" })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getByRole('link', { name: 'My deals' }).getAttribute('href')).toBe('/deals/mine');
  });
});
