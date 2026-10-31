import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../src/shutdown.js';

describe('shutdown', () => {
  it('closes the server and pool once even if called twice', async () => {
    const app = Fastify({ logger: false });
    await app.ready();

    const closeServer = vi.fn(async () => {
      await app.close();
    });
    const closePool = vi.fn(async () => {});
    const logger = pino({ level: 'silent' });
    const shutdown = createShutdownHandler({ closeServer, closePool, logger });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    await shutdown('SIGTERM');

    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(closePool).toHaveBeenCalledTimes(1);
  });
});
