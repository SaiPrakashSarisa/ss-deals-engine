import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

const databaseUrl = 'postgres://user:pass@localhost:5432/ssdeals';

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl, AMAZON_TAG: 'example-21' })).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      DATABASE_URL: databaseUrl,
      LOG_LEVEL: 'info',
      TZ: 'Asia/Kolkata',
      SESSION_COOKIE_NAME: 'ssd_session',
      COOKIE_SECURE: false,
      ALLOWED_ORIGIN: ['http://localhost:3001'],
      AMAZON_TAG: 'example-21',
      SHORT_LINK_HOSTS: ['amzn.to', 'link.amazon'],
      UPLOAD_DIR: path.resolve('uploads'),
      MAX_UPLOAD_MB: 5,
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
        AMAZON_TAG: 'store-21',
        SHORT_LINK_HOSTS: 'amzn.to, link.amazon',
        UPLOAD_DIR: '/tmp/ss-uploads',
        MAX_UPLOAD_MB: '8',
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
      AMAZON_TAG: 'store-21',
      SHORT_LINK_HOSTS: ['amzn.to', 'link.amazon'],
      UPLOAD_DIR: path.resolve('/tmp/ss-uploads'),
      MAX_UPLOAD_MB: 8,
    });
  });

  it('fails with a clear error when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(
      'Invalid environment configuration: DATABASE_URL is required. Set it to a PostgreSQL connection string.',
    );
    expect(() => loadConfig({ DATABASE_URL: '   ' })).toThrow(/DATABASE_URL is required/);
  });

  it('fails when the affiliate tag, short-link hosts, or upload limit is invalid', () => {
    expect(() => loadConfig({ DATABASE_URL: databaseUrl })).toThrow(/AMAZON_TAG is required/);
    expect(() => loadConfig({ DATABASE_URL: databaseUrl, AMAZON_TAG: 'bad tag' })).toThrow(
      /AMAZON_TAG/,
    );
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, AMAZON_TAG: 'example-21', SHORT_LINK_HOSTS: 'nope' }),
    ).toThrow(/SHORT_LINK_HOSTS/);
    expect(() =>
      loadConfig({ DATABASE_URL: databaseUrl, AMAZON_TAG: 'example-21', MAX_UPLOAD_MB: '0' }),
    ).toThrow(/MAX_UPLOAD_MB/);
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
