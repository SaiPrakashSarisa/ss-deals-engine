import type { FastifyInstance, FastifyReply } from 'fastify';
import type { LinkStyle } from '@ss-deals/core';
import type { SessionDeps } from '../auth/service.js';
import { DealHttpError } from '../deals/errors.js';
import { requireAdmin } from '../review/guard.js';
import { STALE_DEAL } from '../review/messages.js';
import {
  listPublications,
  publishDeal,
  publishingStatus,
  resolvePublication,
  type PublishingSettings,
  type PublishLogger,
} from './service.js';
import { createTelegramClient, type TelegramClient, type TelegramResult } from './telegram.js';

const STATUSES = new Set(['queued', 'publishing', 'published', 'failed', 'uncertain']);

export type PublishingRouteDeps = SessionDeps & {
  cookieName: string;
  cookieSecure: boolean;
  enabled: boolean;
  channel: string | null;
  token: string | null;
  timeoutMs: number;
  dailyLimit: number;
  linkStyle: LinkStyle;
  postFooter: string;
  uploadDir: string;
  shortLinkHosts: readonly string[];
  client?: TelegramClient;
  logger?: PublishLogger;
  now?: () => Date;
  beforeRecord?: (result: TelegramResult) => Promise<void>;
};

function readBody(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  return (body as Record<string, unknown>)[key];
}

function readParam(params: unknown, key: string): unknown {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  return (params as Record<string, unknown>)[key];
}

function readQuery(query: unknown, key: string): unknown {
  if (typeof query !== 'object' || query === null) {
    return undefined;
  }
  return (query as Record<string, unknown>)[key];
}

function parseUpdatedAt(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function flag(value: unknown): boolean {
  return value === true;
}

async function handle(reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DealHttpError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    throw error;
  }
}

function settingsOf(deps: PublishingRouteDeps): PublishingSettings {
  return {
    enabled: deps.enabled,
    channel: deps.channel,
    token: deps.token,
    dailyLimit: deps.dailyLimit,
    linkStyle: deps.linkStyle,
    postFooter: deps.postFooter,
    uploadDir: deps.uploadDir,
    shortLinkHosts: deps.shortLinkHosts,
  };
}

function clientOf(deps: PublishingRouteDeps): TelegramClient {
  if (deps.client !== undefined) {
    return deps.client;
  }
  if (deps.token === null) {
    return {
      async sendText() {
        return { kind: 'not_sent', reason: 'Telegram is not configured.' };
      },
      async sendPhoto() {
        return { kind: 'not_sent', reason: 'Telegram is not configured.' };
      },
    };
  }
  return createTelegramClient({ token: deps.token, timeoutMs: deps.timeoutMs });
}

export function registerPublishingRoutes(app: FastifyInstance, deps: PublishingRouteDeps): void {
  const guard = requireAdmin(deps);
  const now = () => deps.now?.() ?? new Date();

  app.get('/api/admin/publishing/status', { preHandler: guard }, async (request, reply) => {
    if (reply.sent || request.authUser === null || request.authUser.role !== 'owner') {
      return;
    }
    return publishingStatus(deps.db, settingsOf(deps), now());
  });

  app.get('/api/admin/publications', { preHandler: guard }, async (request, reply) => {
    if (reply.sent || request.authUser === null || request.authUser.role !== 'owner') {
      return;
    }
    const status = readQuery(request.query, 'status');
    const page = Number(readQuery(request.query, 'page'));
    const pageSize = Number(readQuery(request.query, 'pageSize'));
    if (
      status !== undefined &&
      status !== '' &&
      (typeof status !== 'string' || !STATUSES.has(status))
    ) {
      return reply.code(400).send({ error: 'That status is not a publication status.' });
    }
    return listPublications(deps.db, {
      status: typeof status === 'string' && status.length > 0 ? status : undefined,
      page: Number.isInteger(page) ? page : undefined,
      pageSize: Number.isInteger(pageSize) ? pageSize : undefined,
    });
  });

  app.post('/api/admin/deals/:id/publish', { preHandler: guard }, async (request, reply) => {
    if (reply.sent || request.authUser === null || request.authUser.role !== 'owner') {
      return;
    }
    const id = readParam(request.params, 'id');
    if (typeof id !== 'string') {
      return reply.code(404).send({ error: 'That deal was not found.' });
    }
    const updatedAt = parseUpdatedAt(readBody(request.body, 'updatedAt'));
    if (updatedAt === undefined) {
      return reply.code(400).send({ error: STALE_DEAL });
    }
    const user = request.authUser;
    return handle(reply, () =>
      publishDeal(
        deps.db,
        { id: user.id, now: now() },
        id,
        {
          updatedAt,
          override: flag(readBody(request.body, 'override')),
          confirmUnknownPrice: flag(readBody(request.body, 'confirmUnknownPrice')),
        },
        {
          client: clientOf(deps),
          config: settingsOf(deps),
          logger: deps.logger,
          beforeRecord: deps.beforeRecord,
        },
      ),
    );
  });

  app.post('/api/admin/publications/:id/resolve', { preHandler: guard }, async (request, reply) => {
    if (reply.sent || request.authUser === null || request.authUser.role !== 'owner') {
      return;
    }
    const id = readParam(request.params, 'id');
    const outcome = readBody(request.body, 'outcome');
    if (typeof id !== 'string') {
      return reply.code(404).send({ error: 'That post was not found.' });
    }
    if (outcome !== 'posted' && outcome !== 'not_posted') {
      return reply.code(400).send({ error: 'Choose whether the post went out.' });
    }
    const messageId = readBody(request.body, 'messageId');
    if (
      messageId !== undefined &&
      (typeof messageId !== 'string' || messageId.trim().length === 0)
    ) {
      return reply.code(400).send({ error: 'The message id is not valid.' });
    }
    const user = request.authUser;
    return handle(reply, () =>
      resolvePublication(deps.db, { id: user.id, now: now() }, id, {
        outcome,
        messageId: typeof messageId === 'string' ? messageId.trim() : undefined,
      }),
    );
  });
}
