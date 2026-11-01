import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/env.js';

const token = '123456789:AATestTokenValue';

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TELEGRAM_BOT_TOKEN: token,
    TELEGRAM_CHANNEL: '@ss_super_deals',
    OWNER_TELEGRAM_ID: '424242',
    AMAZON_TAG: 'ssdeals-21',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(validEnv())).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      TELEGRAM_CHANNEL: '@ss_super_deals',
      OWNER_TELEGRAM_ID: 424242,
      AMAZON_TAG: 'ssdeals-21',
      DAILY_POST_LIMIT: 8,
      DATA_DIR: './data',
      TZ: 'Asia/Kolkata',
      SHORT_LINK_HOSTS: ['amzn.to', 'link.amazon'],
      LINK_STYLE: 'text',
      POST_FOOTER: '',
    });
  });

  it('parses explicit values', () => {
    expect(
      loadConfig(
        validEnv({
          NODE_ENV: 'production',
          LOG_LEVEL: 'debug',
          TELEGRAM_CHANNEL: '-1001234567890',
          DAILY_POST_LIMIT: '3',
          DATA_DIR: '/var/quickpost',
          TZ: 'UTC',
          SHORT_LINK_HOSTS: 'amzn.to, link.amazon',
          LINK_STYLE: 'both',
          POST_FOOTER: '  Prices can change.  ',
        }),
      ),
    ).toMatchObject({
      NODE_ENV: 'production',
      LOG_LEVEL: 'debug',
      TELEGRAM_CHANNEL: '-1001234567890',
      DAILY_POST_LIMIT: 3,
      DATA_DIR: '/var/quickpost',
      TZ: 'UTC',
      SHORT_LINK_HOSTS: ['amzn.to', 'link.amazon'],
      LINK_STYLE: 'both',
      POST_FOOTER: 'Prices can change.',
    });
  });

  it('accepts a 120-character footer and rejects a longer one', () => {
    expect(loadConfig(validEnv({ POST_FOOTER: 'x'.repeat(120) })).POST_FOOTER).toBe(
      'x'.repeat(120),
    );
    expect(loadConfig(validEnv({ POST_FOOTER: '   ' })).POST_FOOTER).toBe('');
    expect(() => loadConfig(validEnv({ POST_FOOTER: 'x'.repeat(121) }))).toThrow(
      /POST_FOOTER must be 120 characters or fewer/,
    );
  });

  it('rejects an unknown link style or a bad short-link host', () => {
    expect(() => loadConfig(validEnv({ LINK_STYLE: 'card' }))).toThrow(
      /LINK_STYLE must be text, button, or both/,
    );
    expect(() => loadConfig(validEnv({ SHORT_LINK_HOSTS: 'https://amzn.to' }))).toThrow(
      /SHORT_LINK_HOSTS/,
    );
    expect(loadConfig(validEnv({ LINK_STYLE: ' button ' })).LINK_STYLE).toBe('button');
  });

  it('fails fast without putting the token in the error', () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN is required/);
    expect(() => loadConfig(validEnv({ TELEGRAM_BOT_TOKEN: 'short' }))).toThrow(
      /not a usable token/,
    );

    const secret = '123456789:SUPERSECRETTOKEN';
    expect(() =>
      loadConfig(validEnv({ TELEGRAM_BOT_TOKEN: `${secret} leaked`, TELEGRAM_CHANNEL: 'nope' })),
    ).toThrow(/not a usable token/);

    let message = '';
    expect(() => {
      try {
        loadConfig(validEnv({ TELEGRAM_BOT_TOKEN: secret, TELEGRAM_CHANNEL: 'nope' }));
      } catch (error) {
        message = error instanceof Error ? error.message : '';
        throw error;
      }
    }).toThrow(/TELEGRAM_CHANNEL/);
    expect(message).not.toContain(secret);
  });
});
