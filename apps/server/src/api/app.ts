import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { Database } from '../lib/db.js';
import { registerAuthRoutes, type AuthRouteDeps } from '../modules/auth/routes.js';
import { registerDealRoutes, type DealRouteDeps } from '../modules/deals/routes.js';
import { registerHealthRoutes } from '../modules/health/routes.js';
import { registerReviewRoutes } from '../modules/review/routes.js';

const BODY_LIMIT_BYTES = 16 * 1024;

export type AuthAppOptions = Omit<AuthRouteDeps, 'db' | 'now'> & {
  db: Database['db'];
  now?: () => Date;
};

export type DealsAppOptions = Omit<DealRouteDeps, 'db' | 'now' | 'cookieName' | 'cookieSecure'>;

export type ReviewAppOptions = {
  shortLinkHosts?: readonly string[];
};

export function buildApp(options: {
  checkDb: () => Promise<boolean>;
  logger?: Logger;
  auth?: AuthAppOptions;
  deals?: DealsAppOptions;
  review?: ReviewAppOptions;
}): FastifyInstance {
  const shared = {
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: true,
  };
  const app = (options.logger === undefined
    ? Fastify({ logger: false, ...shared })
    : Fastify({ loggerInstance: options.logger, ...shared })) as unknown as FastifyInstance;

  app.addHook('onRequest', async (_request, reply) => {
    applySecurityHeaders(reply, options.auth?.cookieSecure === true);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode;
    if (statusCode === undefined || statusCode >= 500) {
      request.log.error({ name: error.name }, 'request failed');
      return reply.code(500).send({ error: 'Something went wrong.' });
    }
    if (statusCode === 413) {
      return reply.code(413).send({ error: 'Request is too large.' });
    }
    return reply.code(statusCode).send({ error: 'Request could not be read.' });
  });

  registerHealthRoutes(app, { checkDb: options.checkDb });

  if (options.auth !== undefined) {
    const now = options.auth.now ?? (() => new Date());
    registerAuthRoutes(app, {
      ...options.auth,
      now,
    });
    if (options.deals !== undefined) {
      registerDealRoutes(app, {
        ...options.deals,
        db: options.auth.db,
        now,
        cookieName: options.auth.cookieName,
        cookieSecure: options.auth.cookieSecure,
      });
    }
    registerReviewRoutes(app, {
      db: options.auth.db,
      now,
      cookieName: options.auth.cookieName,
      cookieSecure: options.auth.cookieSecure,
      shortLinkHosts: options.review?.shortLinkHosts ??
        options.deals?.shortLinkHosts ?? ['amzn.to', 'link.amazon'],
      uploadDir: options.deals?.uploadDir ?? '',
      maxUploadBytes: options.deals?.maxUploadBytes ?? 5 * 1024 * 1024,
    });
  }

  return app;
}

function applySecurityHeaders(
  reply: { header: (name: string, value: string) => void },
  cookieSecure: boolean,
): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-dns-prefetch-control', 'off');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  reply.header('cross-origin-resource-policy', 'same-origin');
  reply.header('x-permitted-cross-domain-policies', 'none');
  if (cookieSecure) {
    reply.header('strict-transport-security', 'max-age=15552000; includeSubDomains');
  }
}
