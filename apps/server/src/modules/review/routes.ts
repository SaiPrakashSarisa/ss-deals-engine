import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FORBIDDEN_ERROR, SIGN_IN_REQUIRED } from '../auth/messages.js';
import type { SessionDeps } from '../auth/service.js';
import { dealStatuses, type DealStatus } from '../deals/status.js';
import { requireAdmin } from './guard.js';
import { getAdminDeal, listAdminDeals } from './service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReviewRouteDeps = SessionDeps & {
  cookieName: string;
  cookieSecure: boolean;
  shortLinkHosts: readonly string[];
  now?: () => Date;
};

function readQuery(query: unknown, key: string): unknown {
  if (typeof query !== 'object' || query === null) {
    return undefined;
  }
  return (query as Record<string, unknown>)[key];
}

function readParam(params: unknown, key: string): unknown {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  return (params as Record<string, unknown>)[key];
}

function parseStatusFilter(value: unknown): DealStatus | 'invalid' | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (typeof value === 'string' && (dealStatuses as readonly string[]).includes(value)) {
    return value as DealStatus;
  }
  return 'invalid';
}

function parsePage(value: unknown): number | 'invalid' | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) {
    return 'invalid';
  }
  return num;
}

function parsePageSize(value: unknown): number | 'invalid' | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) {
    return 'invalid';
  }
  return Math.min(50, num);
}

export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  const guard = requireAdmin(deps);

  app.get(
    '/api/admin/deals',
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (reply.sent) {
        return;
      }
      const user = request.authUser;
      if (user === null) {
        return reply.code(401).send({ error: SIGN_IN_REQUIRED });
      }
      if (user.role !== 'owner') {
        return reply.code(403).send({ error: FORBIDDEN_ERROR });
      }

      const statusFilter = parseStatusFilter(readQuery(request.query, 'status'));
      if (statusFilter === 'invalid') {
        return reply.code(400).send({ error: 'That status is not recognised.' });
      }

      const page = parsePage(readQuery(request.query, 'page'));
      if (page === 'invalid') {
        return reply.code(400).send({ error: 'Invalid page number.' });
      }

      const pageSize = parsePageSize(readQuery(request.query, 'pageSize'));
      if (pageSize === 'invalid') {
        return reply.code(400).send({ error: 'Invalid page size.' });
      }

      const result = await listAdminDeals(deps.db, {
        status: statusFilter,
        page,
        pageSize,
      });

      return reply.code(200).send(result);
    },
  );

  app.get(
    '/api/admin/deals/:id',
    { preHandler: guard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (reply.sent) {
        return;
      }
      const user = request.authUser;
      if (user === null) {
        return reply.code(401).send({ error: SIGN_IN_REQUIRED });
      }
      if (user.role !== 'owner') {
        return reply.code(403).send({ error: FORBIDDEN_ERROR });
      }

      const rawId = readParam(request.params, 'id');
      if (typeof rawId !== 'string' || !UUID_PATTERN.test(rawId)) {
        return reply.code(404).send({ error: 'That deal was not found.' });
      }

      const deal = await getAdminDeal(deps.db, rawId, deps.shortLinkHosts);
      if (deal === undefined) {
        return reply.code(404).send({ error: 'That deal was not found.' });
      }

      return reply.code(200).send(deal);
    },
  );
}
