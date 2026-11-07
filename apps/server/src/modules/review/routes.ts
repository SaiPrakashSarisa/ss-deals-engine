import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { FORBIDDEN_ERROR, SIGN_IN_REQUIRED } from '../auth/messages.js';
import type { SessionDeps } from '../auth/service.js';
import { DealHttpError } from '../deals/errors.js';
import {
  IMAGE_INVALID_ERROR,
  IMAGE_MISSING_ERROR,
  IMAGE_SAVE_ERROR,
  IMAGE_TYPE_ERROR,
  imageTooLargeMessage,
} from '../deals/messages.js';
import { dealStatuses, type DealStatus } from '../deals/status.js';
import { parseDealId, parseReviewEdit } from '../deals/validation.js';
import { removeStoredImage, writeStoredImage } from '../uploads/files.js';
import { reencodeImage } from '../uploads/image.js';
import { detectImageKind } from '../uploads/magic.js';
import {
  approveDeal,
  rejectDeal,
  removeAdminImage,
  reopenDeal,
  replaceAdminImage,
  sendDealBack,
  unapproveDeal,
  updateAdminDeal,
  type ReviewActor,
} from './actions.js';
import { requireAdmin } from './guard.js';
import { NOTE_REQUIRED, REASON_REQUIRED, readReviewText } from './messages.js';
import { getAdminDeal, listAdminDeals } from './service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ReviewRouteDeps = SessionDeps & {
  cookieName: string;
  cookieSecure: boolean;
  shortLinkHosts: readonly string[];
  uploadDir: string;
  maxUploadBytes: number;
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

function readBody(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  return (body as Record<string, unknown>)[key];
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

function errorBody(error: DealHttpError): { error: string; fields?: Record<string, string> } {
  return error.fields === undefined
    ? { error: error.message }
    : { error: error.message, fields: error.fields };
}

async function handle(reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof DealHttpError) {
      return reply.code(error.statusCode).send(errorBody(error));
    }
    throw error;
  }
}

async function adminUser(request: FastifyRequest, reply: FastifyReply) {
  if (reply.sent) {
    return undefined;
  }
  const user = request.authUser;
  if (user === null) {
    await reply.code(401).send({ error: SIGN_IN_REQUIRED });
    return undefined;
  }
  if (user.role !== 'owner') {
    await reply.code(403).send({ error: FORBIDDEN_ERROR });
    return undefined;
  }
  return user;
}

function actor(deps: ReviewRouteDeps, userId: string): ReviewActor {
  return {
    id: userId,
    now: deps.now?.() ?? new Date(),
    shortLinkHosts: deps.shortLinkHosts,
  };
}

function parseUpdatedAt(value: unknown): Date | 'invalid' | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return 'invalid';
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'invalid' : parsed;
}

function fieldText(fields: Record<string, unknown> | undefined, key: string): unknown {
  const value = fields?.[key];
  const entry = Array.isArray(value) ? value[0] : value;
  if (typeof entry === 'object' && entry !== null && 'value' in entry) {
    return entry.value;
  }
  return entry;
}

function multipartFailure(
  error: unknown,
  maxUploadBytes: number,
): { statusCode: number; message: string } | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  if (
    code === 'FST_REQ_FILE_TOO_LARGE' ||
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_PARTS_LIMIT'
  ) {
    return { statusCode: 413, message: imageTooLargeMessage(maxUploadBytes) };
  }
  if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE' || code === 'FST_MP_PREMATURE_CLOSE') {
    return { statusCode: 400, message: IMAGE_MISSING_ERROR };
  }
  return undefined;
}

export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  const guard = requireAdmin(deps);

  app.get('/api/admin/deals', { preHandler: guard }, async (request, reply) => {
    const user = await adminUser(request, reply);
    if (user === undefined) {
      return;
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
  });

  app.get('/api/admin/deals/:id', { preHandler: guard }, async (request, reply) => {
    const user = await adminUser(request, reply);
    if (user === undefined) {
      return;
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
  });

  app.patch('/api/admin/deals/:id', { preHandler: guard }, async (request, reply) => {
    const user = await adminUser(request, reply);
    if (user === undefined) {
      return;
    }
    const id = parseDealId(readParam(request.params, 'id'));
    if (id === undefined) {
      return reply.code(404).send({ error: 'That deal was not found.' });
    }
    const parsed = parseReviewEdit(request.body, { shortLinkHosts: deps.shortLinkHosts });
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error, fields: parsed.fields });
    }
    return handle(reply, () => updateAdminDeal(deps.db, actor(deps, user.id), id, parsed.value));
  });

  app.post('/api/admin/deals/:id/approve', { preHandler: guard }, async (request, reply) => {
    return statusAction(deps, request, reply, (id, updatedAt, person) =>
      approveDeal(deps.db, person, id, updatedAt),
    );
  });

  app.post('/api/admin/deals/:id/send-back', { preHandler: guard }, async (request, reply) => {
    if (reply.sent) {
      return;
    }
    const note = readReviewText(readBody(request.body, 'note'), NOTE_REQUIRED);
    if (!note.ok) {
      return reply.code(400).send({ error: note.error });
    }
    return statusAction(deps, request, reply, (id, updatedAt, person) =>
      sendDealBack(deps.db, person, id, updatedAt, note.text),
    );
  });

  app.post('/api/admin/deals/:id/reject', { preHandler: guard }, async (request, reply) => {
    if (reply.sent) {
      return;
    }
    const reason = readReviewText(readBody(request.body, 'reason'), REASON_REQUIRED);
    if (!reason.ok) {
      return reply.code(400).send({ error: reason.error });
    }
    return statusAction(deps, request, reply, (id, updatedAt, person) =>
      rejectDeal(deps.db, person, id, updatedAt, reason.text),
    );
  });

  app.post('/api/admin/deals/:id/reopen', { preHandler: guard }, async (request, reply) => {
    return statusAction(deps, request, reply, (id, updatedAt, person) =>
      reopenDeal(deps.db, person, id, updatedAt),
    );
  });

  app.post('/api/admin/deals/:id/unapprove', { preHandler: guard }, async (request, reply) => {
    return statusAction(deps, request, reply, (id, updatedAt, person) =>
      unapproveDeal(deps.db, person, id, updatedAt),
    );
  });

  app.delete('/api/admin/deals/:id/image', { preHandler: guard }, async (request, reply) => {
    const user = await adminUser(request, reply);
    if (user === undefined) {
      return;
    }
    const id = parseDealId(readParam(request.params, 'id'));
    if (id === undefined) {
      return reply.code(404).send({ error: 'That deal was not found.' });
    }
    const updatedAt = parseUpdatedAt(readBody(request.body, 'updatedAt'));
    if (updatedAt === undefined || updatedAt === 'invalid') {
      return reply.code(400).send({ error: 'Send the latest version of this deal.' });
    }
    return handle(reply, async () => {
      const removed = await removeAdminImage(deps.db, actor(deps, user.id), id, updatedAt);
      await removeStoredImage(deps.uploadDir, removed.previousFilename);
      return removed.deal;
    });
  });

  app.register(async (scope) => {
    await scope.register(multipart, {
      throwFileSizeLimit: true,
      limits: {
        files: 1,
        fileSize: deps.maxUploadBytes,
        fields: 4,
        parts: 8,
      },
    });
    scope.post(
      '/api/admin/deals/:id/image',
      { preHandler: guard, bodyLimit: deps.maxUploadBytes + 64 * 1024 },
      async (request, reply) => {
        const user = await adminUser(request, reply);
        if (user === undefined) {
          return;
        }
        const id = parseDealId(readParam(request.params, 'id'));
        if (id === undefined) {
          return reply.code(404).send({ error: 'That deal was not found.' });
        }
        let filename: string | undefined;
        try {
          const uploaded = await request.file();
          if (uploaded === undefined) {
            return reply.code(400).send({ error: IMAGE_MISSING_ERROR });
          }
          const updatedAt = parseUpdatedAt(fieldText(uploaded.fields, 'updatedAt'));
          if (updatedAt === undefined || updatedAt === 'invalid') {
            return reply.code(400).send({ error: 'Send the latest version of this deal.' });
          }
          const bytes = await uploaded.toBuffer();
          if (uploaded.file.truncated || bytes.length > deps.maxUploadBytes) {
            return reply.code(413).send({ error: imageTooLargeMessage(deps.maxUploadBytes) });
          }
          if (bytes.length === 0) {
            return reply.code(400).send({ error: IMAGE_MISSING_ERROR });
          }
          if (detectImageKind(bytes) === undefined) {
            return reply.code(400).send({ error: IMAGE_TYPE_ERROR });
          }
          const encoded = await reencodeImage(bytes);
          if (encoded === undefined) {
            return reply.code(400).send({ error: IMAGE_INVALID_ERROR });
          }
          try {
            filename = await writeStoredImage(deps.uploadDir, encoded.extension, encoded.bytes);
          } catch {
            return reply.code(500).send({ error: IMAGE_SAVE_ERROR });
          }
          const saved = await replaceAdminImage(deps.db, actor(deps, user.id), id, updatedAt, {
            filename,
            mime: encoded.mime,
          });
          if (saved.previousFilename !== null && saved.previousFilename !== filename) {
            await removeStoredImage(deps.uploadDir, saved.previousFilename);
          }
          return reply.code(200).send(saved.deal);
        } catch (error) {
          if (filename !== undefined) {
            await removeStoredImage(deps.uploadDir, filename);
          }
          const failure = multipartFailure(error, deps.maxUploadBytes);
          if (failure !== undefined) {
            return reply.code(failure.statusCode).send({ error: failure.message });
          }
          return handle(reply, () => {
            throw error;
          });
        }
      },
    );
  });
}

async function statusAction(
  deps: ReviewRouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  work: (id: string, updatedAt: Date, person: ReviewActor) => Promise<unknown>,
): Promise<unknown> {
  const user = await adminUser(request, reply);
  if (user === undefined) {
    return;
  }
  const id = parseDealId(readParam(request.params, 'id'));
  if (id === undefined) {
    return reply.code(404).send({ error: 'That deal was not found.' });
  }
  const updatedAt = parseUpdatedAt(readBody(request.body, 'updatedAt'));
  if (updatedAt === undefined || updatedAt === 'invalid') {
    return reply.code(400).send({ error: 'Send the latest version of this deal.' });
  }
  return handle(reply, () => work(id, updatedAt, actor(deps, user.id)));
}
