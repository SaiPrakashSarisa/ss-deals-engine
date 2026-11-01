import { Writable } from 'node:stream';
import { pino, type DestinationStream, type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';
import { redactToken } from './redact.js';

const redactPaths = [
  'token',
  'TELEGRAM_BOT_TOKEN',
  'botToken',
  'authorization',
  'cookie',
  'password',
  'secret',
  '*.token',
  '*.TELEGRAM_BOT_TOKEN',
  '*.botToken',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.secret',
];

export function startupSummary(config: AppConfig): {
  nodeEnv: AppConfig['NODE_ENV'];
  logLevel: AppConfig['LOG_LEVEL'];
  tz: string;
  channel: string;
  ownerId: number;
  dailyPostLimit: number;
  dataDir: string;
} {
  return {
    nodeEnv: config.NODE_ENV,
    logLevel: config.LOG_LEVEL,
    tz: config.TZ,
    channel: config.TELEGRAM_CHANNEL,
    ownerId: config.OWNER_TELEGRAM_ID,
    dailyPostLimit: config.DAILY_POST_LIMIT,
    dataDir: config.DATA_DIR,
  };
}

export function createLogger(
  config: Pick<AppConfig, 'LOG_LEVEL' | 'TELEGRAM_BOT_TOKEN'>,
  destination?: DestinationStream,
): Logger {
  const sink = destination ?? process.stdout;
  return pino(
    {
      level: config.LOG_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: redactPaths,
        censor: '[Redacted]',
      },
    },
    redactDestination(config.TELEGRAM_BOT_TOKEN, sink),
  );
}

export async function flushLogger(logger: Logger): Promise<void> {
  await new Promise<void>((resolve) => {
    logger.flush(() => {
      resolve();
    });
  });
}

function redactDestination(token: string, inner: DestinationStream): DestinationStream {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        inner.write(redactToken(chunk.toString(), token));
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error('log write failed'));
      }
    },
  });
}
