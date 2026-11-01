import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

const databaseUrl = 'postgres://user:pass@localhost:5432/ssdeals';

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'info',
      TZ: 'Asia/Kolkata',
      SESSION_COOKIE_NAME: 'ssd_session',
      COOKIE_SECURE: false,
      ALLOWED_ORIGIN: ['http://localhost:3001'],
    });
  });

  it('parses explicit values', () => {
    expect(
      loadConfig({
        NODE_ENV: 'production',
        PORT: '8080',
        DATABASE_URL: 'postgresql://user:pass@db.internal:5432/ssdeals',
        LOG_LEVEL: 'debug',
        TZ: 'UTC',
        SESSION_COOKIE_NAME: 'deal_session',
        COOKIE_SECURE: 'true',
        ALLOWED_ORIGIN: 'http://localhost:3001, http://127.0.0.1:3001',
      }),
    ).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      DATABASE_URL: 'postgresql://user:pass@db.internal:5432/ssdeals',
      LOG_LEVEL: 'debug',
      TZ: 'UTC',
      SESSION_COOKIE_NAME: 'deal_session',
      COOKIE_SECURE: true,
      ALLOWED_ORIGIN: ['http://localhost:3001', 'http://127.0.0.1:3001'],
    });
  });

  it('fails with a clear error when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(
      'Invalid environment configuration: DATABASE_URL is required. Set it to a PostgreSQL connection string.',
    );
    expect(() => loadConfig({ DATABASE_URL: '   ' })).toThrow(/DATABASE_URL is required/);
  });

  it('rejects a bad cookie flag, cookie name, or origin', () => {
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, COOKIE_SECURE: 'yes' })).toThrow(
      /COOKIE_SECURE must be true or false/,
    );
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, SESSION_COOKIE_NAME: 'a b' })).toThrow(
      /SESSION_COOKIE_NAME/,
    );
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, ALLOWED_ORIGIN: 'https://example.com/path' }),
    ).toThrow(/ALLOWED_ORIGIN/);
  });
});
