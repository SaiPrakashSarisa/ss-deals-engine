import { z } from 'zod';
import { redactToken } from '../lib/redact.js';

const nodeEnvironments = new Set(['development', 'test', 'production']);
const logLevels = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const linkStyleSchema = z.enum(['text', 'button', 'both']);
const hostnamePattern =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const DEFAULT_SHORT_LINK_HOSTS = ['amzn.to', 'link.amazon'] as const;

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
    TELEGRAM_BOT_TOKEN: z.string().min(10),
    TELEGRAM_CHANNEL: z.string().min(1),
    OWNER_TELEGRAM_ID: z.number().int().positive(),
    AMAZON_TAG: z.string().min(1),
    DAILY_POST_LIMIT: z.number().int().positive(),
    DATA_DIR: z.string().min(1),
    TZ: z.string().min(1),
    SHORT_LINK_HOSTS: z.array(z.string().regex(hostnamePattern)).min(1),
    LINK_STYLE: linkStyleSchema,
    POST_FOOTER: z.string().max(120),
  })
  .strict();

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV === undefined || env.NODE_ENV === '' ? 'development' : env.NODE_ENV;
  const logLevel = env.LOG_LEVEL === undefined || env.LOG_LEVEL === '' ? 'info' : env.LOG_LEVEL;
  const timezone = env.TZ === undefined || env.TZ.trim() === '' ? 'Asia/Kolkata' : env.TZ.trim();
  const token = env.TELEGRAM_BOT_TOKEN?.trim();

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

  assertTimeZone(timezone);
  const telegramToken = requireToken(token);
  const channel = requireChannel(env.TELEGRAM_CHANNEL);
  const ownerId = requireOwnerId(env.OWNER_TELEGRAM_ID);
  const amazonTag = requireAmazonTag(env.AMAZON_TAG);
  const dailyPostLimit = parseDailyPostLimit(env.DAILY_POST_LIMIT);
  const dataDir = parseDataDir(env.DATA_DIR);
  const shortLinkHosts = parseShortLinkHosts(env.SHORT_LINK_HOSTS);
  const linkStyle = parseLinkStyle(env.LINK_STYLE);
  const postFooter = parsePostFooter(env.POST_FOOTER);

  const parsed = configSchema.safeParse({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: logLevel,
    TELEGRAM_BOT_TOKEN: telegramToken,
    TELEGRAM_CHANNEL: channel,
    OWNER_TELEGRAM_ID: ownerId,
    AMAZON_TAG: amazonTag,
    DAILY_POST_LIMIT: dailyPostLimit,
    DATA_DIR: dataDir,
    TZ: timezone,
    SHORT_LINK_HOSTS: shortLinkHosts,
    LINK_STYLE: linkStyle,
    POST_FOOTER: postFooter,
  });

  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration: ${redactToken(formatIssues(parsed.error), telegramToken)}`,
    );
  }

  return parsed.data;
}

function requireToken(value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error('Invalid environment configuration: TELEGRAM_BOT_TOKEN is required');
  }
  if (/\s/u.test(value) || value.length < 10 || value.length > 256) {
    throw new Error('Invalid environment configuration: TELEGRAM_BOT_TOKEN is not a usable token');
  }
  return value;
}

function requireChannel(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error('Invalid environment configuration: TELEGRAM_CHANNEL is required');
  }
  const channel = value.trim();
  const username = /^@[A-Za-z][A-Za-z0-9_]{3,31}$/;
  const numeric = /^-\d{5,}$/;
  if (!username.test(channel) && !numeric.test(channel)) {
    throw new Error(
      'Invalid environment configuration: TELEGRAM_CHANNEL must be an @username or a numeric channel id',
    );
  }
  return channel;
}

function requireOwnerId(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    throw new Error('Invalid environment configuration: OWNER_TELEGRAM_ID is required');
  }
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new Error(
      'Invalid environment configuration: OWNER_TELEGRAM_ID must be a positive integer',
    );
  }
  const ownerId = Number(value.trim());
  if (!Number.isSafeInteger(ownerId)) {
    throw new Error(
      'Invalid environment configuration: OWNER_TELEGRAM_ID must be a positive integer',
    );
  }
  return ownerId;
}

function requireAmazonTag(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new Error('Invalid environment configuration: AMAZON_TAG is required');
  }
  const tag = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tag)) {
    throw new Error(
      'Invalid environment configuration: AMAZON_TAG must be letters, numbers, "_" or "-"',
    );
  }
  return tag;
}

function parseDailyPostLimit(value: string | undefined): number {
  if (value === undefined || value.trim() === '') {
    return 8;
  }
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new Error(
      'Invalid environment configuration: DAILY_POST_LIMIT must be a positive integer',
    );
  }
  const limit = Number(value.trim());
  if (!Number.isSafeInteger(limit) || limit > 1000) {
    throw new Error(
      'Invalid environment configuration: DAILY_POST_LIMIT must be a positive integer up to 1000',
    );
  }
  return limit;
}

function parseDataDir(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    return './data';
  }
  return value.trim();
}

function parseShortLinkHosts(value: string | undefined): string[] {
  const raw =
    value === undefined || value.trim() === '' ? DEFAULT_SHORT_LINK_HOSTS.join(',') : value;
  const hosts = raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  if (hosts.length === 0 || hosts.some((host) => !hostnamePattern.test(host))) {
    throw new Error(
      'Invalid environment configuration: SHORT_LINK_HOSTS must be a comma-separated list of hostnames',
    );
  }
  return hosts;
}

function parsePostFooter(value: string | undefined): string {
  if (value === undefined) {
    return '';
  }
  const footer = value.trim();
  if (footer.length > 120) {
    throw new Error(
      'Invalid environment configuration: POST_FOOTER must be 120 characters or fewer',
    );
  }
  return footer;
}

function parseLinkStyle(value: string | undefined): z.infer<typeof linkStyleSchema> {
  if (value === undefined || value.trim() === '') {
    return 'text';
  }
  const parsed = linkStyleSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new Error('Invalid environment configuration: LINK_STYLE must be text, button, or both');
  }
  return parsed.data;
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    throw new Error('Invalid environment configuration: TZ is not a valid IANA time zone');
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'environment';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
