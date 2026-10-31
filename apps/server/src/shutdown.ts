import type { Logger } from 'pino';
import { flushLogger } from './lib/logger.js';

export type ShutdownHandler = (signal: NodeJS.Signals) => Promise<void>;

export function createShutdownHandler(resources: {
  closeServer: () => Promise<void>;
  closePool: () => Promise<void>;
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
      let serverError: unknown;
      try {
        await resources.closeServer();
      } catch (error) {
        serverError = error;
      }

      await resources.closePool();

      if (serverError !== undefined) {
        resources.logger.error({ err: serverError, signal }, 'shutdown failed');
        await flushLogger(resources.logger);
        throw serverError;
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
