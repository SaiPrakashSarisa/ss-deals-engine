import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublishingDesk } from '../src/components/admin/PublishingDesk';
import { ReviewScreen } from '../src/components/admin/ReviewScreen';
import type { AdminDeal } from '../src/components/admin/types';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

function deal(overrides: Partial<AdminDeal> = {}): AdminDeal {
  return {
    id: 'deal-1',
    title: 'Blue kettle',
    price: 1499,
    oldPrice: null,
    oldPriceVerified: false,
    hasImage: false,
    createdBy: 'Grace Hopper',
    sourceNote: null,
    submittedAt: '2026-11-08T04:00:00.000Z',
    status: 'approved',
    updatedAt: '2026-11-08T04:00:00.000Z',
    highlights: [],
    offer: null,
    clerkNotes: null,
    reviewNote: null,
    rejectedReason: null,
    previewEnabled: true,
    productUrl: 'https://www.amazon.in/dp/B0TEST1234',
    taggedUrl: 'https://www.amazon.in/dp/B0TEST1234?tag=example-21',
    shortLink: null,
    asin: 'B0TEST1234',
    image: null,
    duplicate: { hasActiveDeal: false, repost: { allowed: true, reason: 'first_post' } },
    preview: {
      ok: true,
      html: '<b>Blue kettle</b>',
      caption: '<b>Blue kettle</b>',
      characterCount: 16,
      warnings: [],
      forbiddenWords: [],
    },
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const statusBody = {
  enabled: true,
  paused: false,
  dailyLimit: 8,
  postedToday: 1,
  channel: '@deals_channel',
  nextScheduled: null,
  queued: 0,
  uncertain: 0,
  minGapMinutes: 15,
};

describe('publishing screens', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stub(
    handler: (
      url: string,
      init?: RequestInit,
    ) => ReturnType<typeof json> | Promise<ReturnType<typeof json>>,
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/api/deals/config')) {
          return json({ shortLinkHosts: ['amzn.to'] });
        }
        return handler(url, init);
      }),
    );
  }

  it('confirms the channel, then offers an override and the unknown-price check', async () => {
    const user = userEvent.setup();
    const calls: Array<{ url: string; body: string }> = [];
    stub(async (url, init) => {
      calls.push({ url, body: String(init?.body ?? '') });
      if (url.includes('/api/admin/publications?')) {
        return json({ items: [] });
      }
      if (url.endsWith('/publishing/status')) {
        return json(statusBody);
      }
      if (calls.filter((call) => call.url.endsWith('/publish')).length === 1) {
        return json({ error: "Today's post limit has been reached." }, 409);
      }
      if (calls.filter((call) => call.url.endsWith('/publish')).length === 2) {
        return json({ error: 'The earlier posted price is missing.' }, 409);
      }
      return json({
        publication: {
          id: 'pub-1',
          dealId: 'deal-1',
          status: 'published',
          lastError: null,
          externalMessageId: '4',
          publishedAt: '2026-11-08T04:30:00.000Z',
        },
        deal: { id: 'deal-1', status: 'published', updatedAt: '2026-11-08T04:30:00.000Z' },
      });
    });
    render(<ReviewScreen initialDeal={deal()} />);
    await user.click(screen.getByRole('button', { name: 'Publish now' }));
    expect(await screen.findByText('Post this to @deals_channel?')).toBeTruthy();
    expect(screen.queryByText(/SECRET/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Post it' }));
    expect(await screen.findByRole('dialog', { name: 'Daily limit' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Override' }));
    const box = await screen.findByRole('checkbox', { name: /I checked the channel/ });
    expect(screen.getByRole('button', { name: 'Post it' })).toHaveProperty('disabled', true);
    await user.click(box);
    await user.click(screen.getByRole('button', { name: 'Post it' }));
    expect(await screen.findByText(/^Posted /)).toBeTruthy();
    const last = calls.filter((call) => call.url.endsWith('/publish')).at(-1);
    expect(last?.body).toContain('"override":true');
    expect(last?.body).toContain('"confirmUnknownPrice":true');
  });

  it('limits the schedule picker to the next 7 days in India time and unschedules', async () => {
    const user = userEvent.setup();
    stub(async (url) => {
      if (url.includes('/api/admin/publications?')) {
        return json({ items: [] });
      }
      if (url.endsWith('/schedule')) {
        return json({
          publication: {
            id: 'pub-2',
            dealId: 'deal-1',
            status: 'queued',
            lastError: null,
            externalMessageId: null,
            publishedAt: null,
          },
          deal: { status: 'scheduled', updatedAt: '2026-11-08T05:00:00.000Z' },
        });
      }
      if (url.endsWith('/unschedule')) {
        return json({ deal: { status: 'approved', updatedAt: '2026-11-08T05:10:00.000Z' } });
      }
      return json({ items: [] });
    });
    render(<ReviewScreen initialDeal={deal()} />);
    await user.click(screen.getByRole('button', { name: 'Schedule' }));
    const input = screen.getByLabelText('India time');
    const min = new Date(`${input.getAttribute('min')}:00+05:30`).getTime();
    const max = new Date(`${input.getAttribute('max')}:00+05:30`).getTime();
    const opened = Date.now();
    expect(min).toBeGreaterThan(opened);
    expect(max - opened).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(max - opened).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    await user.click(screen.getByRole('button', { name: 'Schedule this time' }));
    expect(await screen.findByRole('button', { name: 'Unschedule' })).toBeTruthy();
    expect(screen.getByLabelText('Title')).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Unschedule' }));
    expect(await screen.findByRole('button', { name: 'Publish now' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('resolves an uncertain post', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    stub(async (url, init) => {
      if (url.includes('/resolve')) {
        calls.push(String(init?.body ?? ''));
        return json({
          publication: {
            id: 'pub-3',
            dealId: 'deal-1',
            status: calls.length === 1 ? 'published' : 'failed',
            lastError: null,
            externalMessageId: '9',
            publishedAt: '2026-11-08T04:30:00.000Z',
          },
          deal: {
            status: calls.length === 1 ? 'published' : 'approved',
            updatedAt: '2026-11-08T04:40:00.000Z',
          },
        });
      }
      return json({
        items: [
          {
            id: 'pub-3',
            dealId: 'deal-1',
            title: 'Blue kettle',
            status: 'uncertain',
            mode: 'text',
            origin: 'app',
            lastError: 'Check the channel.',
            externalMessageId: null,
            publishedAt: null,
            scheduledFor: null,
            createdAt: '2026-11-08T04:00:00.000Z',
          },
        ],
      });
    });
    render(<ReviewScreen initialDeal={deal({ status: 'approved' })} />);
    expect(await screen.findByText('Check the channel.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'It was posted' }));
    await user.type(screen.getByLabelText('Message id'), '9');
    await user.click(screen.getByRole('button', { name: 'It was posted' }));
    expect(calls[0]).toContain('"messageId":"9"');
    expect(calls[0]).toContain('"posted"');
  });

  it('shows a post that is waiting for the next day', async () => {
    stub(async (url) => {
      if (url.includes('/api/admin/publications?')) {
        return json({
          items: [
            {
              id: 'pub-wait',
              dealId: 'deal-1',
              title: 'Blue kettle',
              status: 'queued',
              mode: 'text',
              origin: 'app',
              lastError: "Waiting for tomorrow's limit",
              externalMessageId: null,
              publishedAt: null,
              scheduledFor: '2026-11-09T00:30:00.000Z',
              createdAt: '2026-11-08T18:21:00.000Z',
            },
          ],
        });
      }
      return json({ items: [] });
    });
    render(<ReviewScreen initialDeal={deal({ status: 'scheduled' })} />);
    expect(await screen.findByText("Waiting for tomorrow's limit")).toBeTruthy();
  });

  it('shows paused and repost refusals', async () => {
    const user = userEvent.setup();
    let posts = 0;
    stub(async (url) => {
      if (url.includes('/api/admin/publications?')) {
        return json({ items: [] });
      }
      if (url.endsWith('/publishing/status')) {
        return json(statusBody);
      }
      posts += 1;
      return json(
        {
          error:
            posts === 1
              ? 'Publishing is paused.'
              : 'The price is not lower than the last posted price.',
        },
        409,
      );
    });
    const { unmount } = render(<ReviewScreen initialDeal={deal()} />);
    await user.click(screen.getByRole('button', { name: 'Publish now' }));
    await user.click(await screen.findByRole('button', { name: 'Post it' }));
    expect(await screen.findByText('Publishing is paused.')).toBeTruthy();
    unmount();
    render(<ReviewScreen initialDeal={deal()} />);
    await user.click(screen.getByRole('button', { name: 'Publish now' }));
    await user.click(await screen.findByRole('button', { name: 'Post it' }));
    expect(
      await screen.findByText('The price is not lower than the last posted price.'),
    ).toBeTruthy();
  });

  it('shows the status card, an empty history, and a paged table', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/publishing/status')) {
          return json({
            ...statusBody,
            paused: false,
            nextScheduled: '2026-11-08T06:00:00.000Z',
            uncertain: 2,
          });
        }
        if (url.includes('page=2')) {
          return json({ items: [] });
        }
        if (init?.method === 'POST' && url.endsWith('/pause')) {
          return json({ ...statusBody, paused: true });
        }
        return json({
          items: Array.from({ length: 20 }, (_, index) => ({
            id: `pub-${index}`,
            dealId: `deal-${index}`,
            title: index === 0 ? 'Imported kettle' : `Deal ${index}`,
            status: 'published',
            mode: 'text',
            origin: index === 0 ? 'quickpost_import' : 'app',
            lastError: index === 1 ? 'Telegram rejected the post.' : null,
            externalMessageId: '3',
            publishedAt: '2026-11-08T04:30:00.000Z',
            scheduledFor: null,
            createdAt: '2026-11-08T04:30:00.000Z',
          })),
        });
      }),
    );
    render(<PublishingDesk />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(await screen.findByText('Publishing is on.')).toBeTruthy();
    expect(screen.getByText('Posted today: 1 of 8')).toBeTruthy();
    expect(screen.getByText('Uncertain: 2')).toBeTruthy();
    expect(screen.getByText('Channel: @deals_channel')).toBeTruthy();
    expect((screen.getByLabelText('Minimum gap in minutes') as HTMLInputElement).value).toBe('15');
    expect(screen.getByText(/Imported/)).toBeTruthy();
    expect(screen.getByText('Telegram rejected the post.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('No posts yet.')).toBeTruthy();
  });
});
