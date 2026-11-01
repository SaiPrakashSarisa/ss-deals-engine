import { pino, type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.password',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'authorization',
  'cookie',
  'token',
  'sessionToken',
  'accessToken',
  'access_token',
  'password',
  'secret',
  'DATABASE_URL',
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.sessionToken',
  '*.accessToken',
  '*.access_token',
  '*.password',
  '*.secret',
  '*.DATABASE_URL',
  '*.headers.authorization',
  '*.headers.cookie',
];

export function databaseTarget(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    const port = parsed.port === '' ? '5432' : parsed.port;
    const name = parsed.pathname.replace(/^\//, '');
    return `${parsed.hostname}:${port}/${name}`;
  } catch {
    return 'unparseable';
  }
}

export function startupSummary(config: AppConfig): {
  nodeEnv: AppConfig['NODE_ENV'];
  port: number;
  logLevel: AppConfig['LOG_LEVEL'];
  tz: string;
  database: string;
} {
  return {
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    logLevel: config.LOG_LEVEL,
    tz: config.TZ,
    database: databaseTarget(config.DATABASE_URL),
  };
}

export function createLogger(
  config: Pick<AppConfig, 'LOG_LEVEL'>,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: config.LOG_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: redactPaths,
        censor: '[Redacted]',
      },
    },
    destination,
  );
}

export async function flushLogger(logger: Logger): Promise<void> {
  await new Promise<void>((resolve) => {
    logger.flush(() => {
      resolve();
    });
  });
}
