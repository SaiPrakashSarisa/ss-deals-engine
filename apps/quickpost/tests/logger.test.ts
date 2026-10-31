import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, flushLogger, startupSummary } from '../src/lib/logger.js';
import { testConfig, TOKEN } from './helpers.js';

describe('logger', () => {
  it('summarises startup config without the bot token', () => {
    const summary = startupSummary(testConfig());
    const serialized = JSON.stringify(summary);

    expect(summary).toMatchObject({
      channel: '@ss_super_deals',
      ownerId: 424242,
      dailyPostLimit: 8,
      tz: 'Asia/Kolkata',
    });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('AATestTokenValue');
  });

  it('redacts the token from messages and fields', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger({ ...testConfig(), LOG_LEVEL: 'info' }, stream);
    logger.info(
      { TELEGRAM_BOT_TOKEN: TOKEN, nested: { token: TOKEN } },
      `polling https://api.telegram.org/bot${TOKEN}/getUpdates`,
    );
    await flushLogger(logger);

    const output = lines.join('');
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain('AATestTokenValue');
    expect(output).toContain('[Redacted]');
  });
});
