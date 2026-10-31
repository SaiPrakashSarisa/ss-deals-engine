import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../src/lib/shutdown.js';

describe('shutdown', () => {
  it('stops the bot once even if called twice', async () => {
    const stopBot = vi.fn(async () => {});
    const logger = pino({ level: 'silent' });
    const shutdown = createShutdownHandler({ stopBot, logger });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    await shutdown('SIGTERM');

    expect(stopBot).toHaveBeenCalledTimes(1);
  });
});
