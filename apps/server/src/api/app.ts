import Fastify, { type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { registerHealthRoutes } from '../modules/health/routes.js';

export function buildApp(options: {
  checkDb: () => Promise<boolean>;
  logger?: Logger;
}): FastifyInstance {
  // Pino 10's logger type and Fastify's default instance type differ. The HTTP API is the same.
  const app = (options.logger === undefined
    ? Fastify({ logger: false })
    : Fastify({ loggerInstance: options.logger })) as unknown as FastifyInstance;

  registerHealthRoutes(app, { checkDb: options.checkDb });
  return app;
}
