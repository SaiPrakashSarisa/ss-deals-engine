import type { Logger } from 'pino';
import { flushLogger } from './logger.js';

export type ShutdownHandler = (signal: NodeJS.Signals) => Promise<void>;

export function createShutdownHandler(resources: {
  stopBot: () => Promise<void>;
  logger: Logger;
}): ShutdownHandler {
  let pending: Promise<void> | undefined;

  return (signal) => {
    if (pending !== undefined) {
      resources.logger.info({ signal }, 'shutdown already in progress');
      return pending;
    }

    pending = (async () => {
      resources.logger.info({ signal }, 'shutdown started');
      try {
        await resources.stopBot();
      } catch (error) {
        const name = error instanceof Error ? error.name : 'Error';
        resources.logger.error({ name, signal }, 'shutdown failed');
        await flushLogger(resources.logger);
        throw error;
      }

      resources.logger.info({ signal }, 'shutdown complete');
      await flushLogger(resources.logger);
    })();

    return pending;
  };
}

export function installSignalHandlers(shutdown: ShutdownHandler, logger: Logger): void {
  const onSignal = (signal: NodeJS.Signals) => {
    shutdown(signal)
      .then(() => {
        process.exit(0);
      })
      .catch(() => {
        logger.error({ signal }, 'exiting after shutdown failure');
        process.exit(1);
      });
  };

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
}
