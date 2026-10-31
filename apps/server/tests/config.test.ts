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
      }),
    ).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      DATABASE_URL: 'postgresql://user:pass@db.internal:5432/ssdeals',
      LOG_LEVEL: 'debug',
      TZ: 'UTC',
    });
  });

  it('fails with a clear error when DATABASE_URL is missing', () => {
    expect(() => loadConfig({})).toThrow(
      'Invalid environment configuration: DATABASE_URL is required. Set it to a PostgreSQL connection string.',
    );
    expect(() => loadConfig({ DATABASE_URL: '   ' })).toThrow(/DATABASE_URL is required/);
  });
});
