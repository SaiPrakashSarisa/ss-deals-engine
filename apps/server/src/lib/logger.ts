import { pino, type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'currentPassword',
  'newPassword',
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
  'TELEGRAM_BOT_TOKEN',
  'telegramBotToken',
  'botToken',
  '*.authorization',
  '*.cookie',
  '*.token',
  '*.sessionToken',
  '*.accessToken',
  '*.access_token',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.secret',
  '*.DATABASE_URL',
  '*.TELEGRAM_BOT_TOKEN',
  '*.telegramBotToken',
  '*.botToken',
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
  publishingEnabled: boolean;
  telegramChannel: string | null;
} {
  return {
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    logLevel: config.LOG_LEVEL,
    tz: config.TZ,
    database: databaseTarget(config.DATABASE_URL),
    publishingEnabled: config.PUBLISHING_ENABLED,
    telegramChannel: config.TELEGRAM_CHANNEL,
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
