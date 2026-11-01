import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, startupSummary } from '../src/lib/logger.js';
import type { AppConfig } from '../src/config/env.js';

const config: AppConfig = {
  NODE_ENV: 'test',
  PORT: 3000,
  DATABASE_URL: 'postgres://appuser:supersecret@db.internal:5432/ssdeals',
  LOG_LEVEL: 'info',
  TZ: 'Asia/Kolkata',
  SESSION_COOKIE_NAME: 'ssd_session',
  COOKIE_SECURE: false,
  ALLOWED_ORIGIN: ['http://localhost:3001'],
};

describe('logger', () => {
  it('summarises startup config without secrets', () => {
    const summary = startupSummary(config);
    const serialized = JSON.stringify(summary);

    expect(summary).toEqual({
      nodeEnv: 'test',
      port: 3000,
      logLevel: 'info',
      tz: 'Asia/Kolkata',
      database: 'db.internal:5432/ssdeals',
    });
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('appuser');
  });

  it('redacts authorization and token fields', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger = createLogger({ LOG_LEVEL: 'info' }, stream);

    logger.info(
      {
        authorization: 'Bearer secret-token',
        nested: { token: 'abc', password: 'hidden', sessionToken: 'raw-session-token' },
        req: {
          body: { password: 'from-body' },
          headers: { cookie: 'ssd_session=raw-session-token' },
        },
      },
      'example',
    );

    const output = lines.join('');
    expect(output).not.toContain('secret-token');
    expect(output).not.toContain('hidden');
    expect(output).not.toContain('from-body');
    expect(output).not.toContain('raw-session-token');
    expect(output).toContain('[Redacted]');
  });
});
