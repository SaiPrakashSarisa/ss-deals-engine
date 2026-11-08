import type { Pool } from 'pg';
import {
  publishNextDue,
  type PublishActor,
  type PublishLogger,
  type PublishingSettings,
  type TickResult,
} from './service.js';
import type { TelegramClient, TelegramResult } from './telegram.js';

const PUBLISHER_LOCK = '742001';

type TickDeps = {
  client: TelegramClient;
  config: PublishingSettings;
  logger?: PublishLogger;
  beforeRecord?: (result: TelegramResult) => Promise<void>;
};

export async function runSchedulerTick(
  pool: Pool,
  db: Parameters<typeof publishNextDue>[0],
  actor: PublishActor,
  deps: TickDeps,
): Promise<TickResult> {
  const client = await pool.connect();
  try {
    const locked = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [PUBLISHER_LOCK],
    );
    if (locked.rows[0]?.locked !== true) {
      return { kind: 'busy' };
    }
    try {
      return await publishNextDue(db, actor, deps);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [PUBLISHER_LOCK]);
    }
  } finally {
    client.release();
  }
}

export function startPublishingLoop(options: { intervalMs: number; run: () => Promise<void> }): {
  stop: () => Promise<void>;
} {
  let stopped = false;
  let current = Promise.resolve()
    .then(() => options.run())
    .then(() => undefined)
    .catch(() => undefined);
  const timer = setInterval(() => {
    if (stopped) {
      return;
    }
    current = current
      .then(() => (stopped ? undefined : options.run()))
      .then(() => undefined)
      .catch(() => undefined);
  }, options.intervalMs);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await current;
    },
  };
}
