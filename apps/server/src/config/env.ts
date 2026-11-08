import path from 'node:path';
import { z } from 'zod';
import { ensureUploadDir } from './uploads.js';

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    PORT: z.number().int().min(1).max(65535),
    DATABASE_URL: z.string().min(1),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    TZ: z.string().min(1),
    SESSION_COOKIE_NAME: z.string().regex(/^[A-Za-z0-9_-]+$/),
    COOKIE_SECURE: z.boolean(),
    ALLOWED_ORIGIN: z.array(z.string().min(1)).min(1),
    AMAZON_TAG: z.string().min(1).max(64),
    SHORT_LINK_HOSTS: z.array(z.string().min(1)).min(1),
    UPLOAD_DIR: z.string().min(1),
    MAX_UPLOAD_MB: z.number().int().min(1).max(25),
    PUBLISHING_ENABLED: z.boolean(),
    TELEGRAM_BOT_TOKEN: z.string().min(1).nullable(),
    TELEGRAM_CHANNEL: z.string().min(2).nullable(),
    TELEGRAM_TIMEOUT_MS: z.number().int().min(1000).max(120_000),
    DAILY_POST_LIMIT: z.number().int().min(1).max(100),
    LINK_STYLE: z.enum(['text', 'button', 'both']),
    POST_FOOTER: z.string().max(120),
  })
  .strict();

export type AppConfig = z.infer<typeof configSchema>;

const nodeEnvironments = new Set(['development', 'test', 'production']);
const logLevels = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function requireDatabaseUrl(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      'Invalid environment configuration: DATABASE_URL is required. Set it to a PostgreSQL connection string.',
    );
  }

  const databaseUrl = value.trim();
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error(
      'Invalid environment configuration: DATABASE_URL must start with postgres:// or postgresql://',
    );
  }

  return databaseUrl;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return 3000;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(
      'Invalid environment configuration: PORT must be an integer between 1 and 65535',
    );
  }

  const port = Number(value);
  if (port < 1 || port > 65535) {
    throw new Error(
      'Invalid environment configuration: PORT must be an integer between 1 and 65535',
    );
  }

  return port;
}

function parseCookieSecure(value: string | undefined): boolean {
  if (value === undefined || value.trim() === '') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error('Invalid environment configuration: COOKIE_SECURE must be true or false');
}

function parseCookieName(value: string | undefined): string {
  const name = value === undefined || value.trim() === '' ? 'ssd_session' : value.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      'Invalid environment configuration: SESSION_COOKIE_NAME must contain only letters, numbers, "_" or "-"',
    );
  }
  return name;
}

function parseAmazonTag(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      'Invalid environment configuration: AMAZON_TAG is required. Set it to the Amazon affiliate tag.',
    );
  }
  const tag = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tag)) {
    throw new Error(
      'Invalid environment configuration: AMAZON_TAG must be 1 to 64 letters, numbers, "_" or "-"',
    );
  }
  return tag;
}

function parseShortLinkHosts(value: string | undefined): string[] {
  const raw = value === undefined || value.trim() === '' ? 'amzn.to,link.amazon' : value;
  const hosts = [
    ...new Set(
      raw
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter((host) => host.length > 0),
    ),
  ];
  const hostPattern = /^[a-z0-9.-]+$/;
  if (
    hosts.length === 0 ||
    hosts.some((host) => !hostPattern.test(host) || !host.includes('.') || host.includes('..'))
  ) {
    throw new Error(
      'Invalid environment configuration: SHORT_LINK_HOSTS must be a comma-separated list of hostnames',
    );
  }
  return hosts;
}

function parseUploadDir(value: string | undefined): string {
  const raw = value === undefined || value.trim() === '' ? 'uploads' : value.trim();
  if (raw.includes('\0')) {
    throw new Error('Invalid environment configuration: UPLOAD_DIR is not a valid path');
  }
  return path.resolve(raw);
}

function parseMaxUploadMb(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return 5;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(
      'Invalid environment configuration: MAX_UPLOAD_MB must be a whole number of megabytes from 1 to 25',
    );
  }
  const parsed = Number(value.trim());
  if (parsed < 1 || parsed > 25) {
    throw new Error(
      'Invalid environment configuration: MAX_UPLOAD_MB must be a whole number of megabytes from 1 to 25',
    );
  }
  return parsed;
}

function parseBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(`Invalid environment configuration: ${name} must be true or false`);
}

function parsePositiveInt(
  value: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(
      `Invalid environment configuration: ${name} must be a whole number from ${min} to ${max}`,
    );
  }
  const parsed = Number(value.trim());
  if (parsed < min || parsed > max) {
    throw new Error(
      `Invalid environment configuration: ${name} must be a whole number from ${min} to ${max}`,
    );
  }
  return parsed;
}

function parseLinkStyle(value: string | undefined): 'text' | 'button' | 'both' {
  if (value === undefined || value.trim() === '') {
    return 'text';
  }
  const style = value.trim().toLowerCase();
  if (style === 'text' || style === 'button' || style === 'both') {
    return style;
  }
  throw new Error('Invalid environment configuration: LINK_STYLE must be text, button, or both');
}

function parseFooter(value: string | undefined): string {
  const footer = value?.trim() ?? '';
  if (footer.length > 120) {
    throw new Error(
      'Invalid environment configuration: POST_FOOTER must be at most 120 characters',
    );
  }
  return footer;
}

function parseTelegram(
  env: NodeJS.ProcessEnv,
  enabled: boolean,
): {
  token: string | null;
  channel: string | null;
} {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
  const channel = env.TELEGRAM_CHANNEL?.trim() ?? '';
  if (token.length > 0 && /\s/.test(token)) {
    throw new Error(
      'Invalid environment configuration: TELEGRAM_BOT_TOKEN must not contain spaces',
    );
  }
  if (channel.length > 0 && !/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(channel)) {
    throw new Error('Invalid environment configuration: TELEGRAM_CHANNEL must be an @username');
  }
  if (enabled && token.length === 0) {
    throw new Error(
      'Invalid environment configuration: TELEGRAM_BOT_TOKEN is required when PUBLISHING_ENABLED is true',
    );
  }
  if (enabled && channel.length === 0) {
    throw new Error(
      'Invalid environment configuration: TELEGRAM_CHANNEL is required when PUBLISHING_ENABLED is true. Set it to an @username.',
    );
  }
  return {
    token: token.length > 0 ? token : null,
    channel: channel.length > 0 ? channel : null,
  };
}

function parseAllowedOrigins(value: string | undefined): string[] {
  const raw = value === undefined || value.trim() === '' ? 'http://localhost:3001' : value;
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const originPattern = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;
  if (origins.length === 0 || origins.some((origin) => !originPattern.test(origin))) {
    throw new Error(
      'Invalid environment configuration: ALLOWED_ORIGIN must be a comma-separated list of http(s) origins',
    );
  }
  return origins;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'environment';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV === undefined || env.NODE_ENV === '' ? 'development' : env.NODE_ENV;
  const logLevel = env.LOG_LEVEL === undefined || env.LOG_LEVEL === '' ? 'info' : env.LOG_LEVEL;
  const timezone = env.TZ === undefined || env.TZ.trim() === '' ? 'Asia/Kolkata' : env.TZ.trim();

  if (!nodeEnvironments.has(nodeEnv)) {
    throw new Error(
      'Invalid environment configuration: NODE_ENV must be development, test, or production',
    );
  }

  if (!logLevels.has(logLevel)) {
    throw new Error(
      'Invalid environment configuration: LOG_LEVEL must be fatal, error, warn, info, debug, trace, or silent',
    );
  }

  const publishingEnabled = parseBoolean(env.PUBLISHING_ENABLED, 'PUBLISHING_ENABLED', false);
  const telegram = parseTelegram(env, publishingEnabled);
  const parsed = configSchema.safeParse({
    NODE_ENV: nodeEnv,
    PORT: parsePort(env.PORT),
    DATABASE_URL: requireDatabaseUrl(env.DATABASE_URL),
    LOG_LEVEL: logLevel,
    TZ: timezone,
    SESSION_COOKIE_NAME: parseCookieName(env.SESSION_COOKIE_NAME),
    COOKIE_SECURE: parseCookieSecure(env.COOKIE_SECURE),
    ALLOWED_ORIGIN: parseAllowedOrigins(env.ALLOWED_ORIGIN),
    AMAZON_TAG: parseAmazonTag(env.AMAZON_TAG),
    SHORT_LINK_HOSTS: parseShortLinkHosts(env.SHORT_LINK_HOSTS),
    UPLOAD_DIR: parseUploadDir(env.UPLOAD_DIR),
    MAX_UPLOAD_MB: parseMaxUploadMb(env.MAX_UPLOAD_MB),
    PUBLISHING_ENABLED: publishingEnabled,
    TELEGRAM_BOT_TOKEN: telegram.token,
    TELEGRAM_CHANNEL: telegram.channel,
    TELEGRAM_TIMEOUT_MS: parsePositiveInt(
      env.TELEGRAM_TIMEOUT_MS,
      'TELEGRAM_TIMEOUT_MS',
      15_000,
      1000,
      120_000,
    ),
    DAILY_POST_LIMIT: parsePositiveInt(env.DAILY_POST_LIMIT, 'DAILY_POST_LIMIT', 8, 1, 100),
    LINK_STYLE: parseLinkStyle(env.LINK_STYLE),
    POST_FOOTER: parseFooter(env.POST_FOOTER),
  });

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${formatIssues(parsed.error)}`);
  }

  ensureUploadDir(parsed.data.UPLOAD_DIR);
  return parsed.data;
}
