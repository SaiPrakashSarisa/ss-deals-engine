import { z } from 'zod';

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

  const parsed = configSchema.safeParse({
    NODE_ENV: nodeEnv,
    PORT: parsePort(env.PORT),
    DATABASE_URL: requireDatabaseUrl(env.DATABASE_URL),
    LOG_LEVEL: logLevel,
    TZ: timezone,
    SESSION_COOKIE_NAME: parseCookieName(env.SESSION_COOKIE_NAME),
    COOKIE_SECURE: parseCookieSecure(env.COOKIE_SECURE),
    ALLOWED_ORIGIN: parseAllowedOrigins(env.ALLOWED_ORIGIN),
  });

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${formatIssues(parsed.error)}`);
  }

  return parsed.data;
}
