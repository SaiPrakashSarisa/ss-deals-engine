import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config/env.js';
import { createDb } from '../lib/db.js';
import { isEntrypoint } from '../lib/entrypoint.js';
import { createLogger, startupSummary } from '../lib/logger.js';
import { recoverInterruptedPublishing } from '../modules/publishing/service.js';
import { runSchedulerTick, startPublishingLoop } from '../modules/publishing/scheduler.js';
import { createTelegramClient } from '../modules/publishing/telegram.js';
import { createShutdownHandler, installSignalHandlers } from '../shutdown.js';

const HEARTBEAT_INTERVAL_MS = 60_000;
const HEARTBEAT_PATH = '/tmp/ss-deals-worker-heartbeat';

function writeHeartbeat(): void {
  writeFileSync(HEARTBEAT_PATH, `${Date.now()}\n`);
}

export async function startWorker(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  logger.info(startupSummary(config), 'worker starting');

  const { pool, db } = createDb(config.DATABASE_URL, logger);
  writeHeartbeat();
  logger.info({ uptimeSeconds: Math.floor(process.uptime()) }, 'heartbeat');

  await recoverInterruptedPublishing(db, new Date());
  const botToken = config.TELEGRAM_BOT_TOKEN;
  const channel = config.TELEGRAM_CHANNEL;
  const publishing =
    config.PUBLISHING_ENABLED && botToken !== null && channel !== null
      ? startPublishingLoop({
          intervalMs: config.SCHEDULER_INTERVAL_SECONDS * 1000,
          run: async () => {
            try {
              await runSchedulerTick(
                pool,
                db,
                { id: null, now: new Date() },
                {
                  client: createTelegramClient({
                    token: botToken,
                    timeoutMs: config.TELEGRAM_TIMEOUT_MS,
                  }),
                  config: {
                    enabled: true,
                    channel,
                    token: botToken,
                    dailyLimit: config.DAILY_POST_LIMIT,
                    minGapMinutes: config.MIN_POST_GAP_MINUTES,
                    maxLateMinutes: config.MAX_LATE_MINUTES,
                    linkStyle: config.LINK_STYLE,
                    postFooter: config.POST_FOOTER,
                    uploadDir: config.UPLOAD_DIR,
                    shortLinkHosts: config.SHORT_LINK_HOSTS,
                  },
                  logger,
                },
              );
            } catch (error) {
              logger.error(
                { name: error instanceof Error ? error.name : 'Error' },
                'scheduler tick failed',
              );
            }
          },
        })
      : undefined;

  const timer = setInterval(() => {
    writeHeartbeat();
    logger.info({ uptimeSeconds: Math.floor(process.uptime()) }, 'heartbeat');
  }, HEARTBEAT_INTERVAL_MS);

  const shutdown = createShutdownHandler({
    closeServer: async () => {
      clearInterval(timer);
      await publishing?.stop();
    },
    closePool: () => pool.end(),
    logger,
  });
  installSignalHandlers(shutdown, logger);
}

if (isEntrypoint(import.meta.url)) {
  startWorker().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'worker failed to start';
    console.error(message);
    process.exit(1);
  });
}
