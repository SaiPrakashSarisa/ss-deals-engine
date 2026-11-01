import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { DealStatusTransitionError } from './status.js';
import { DealHttpError } from './errors.js';
import { requireSession } from './guard.js';
import {
  DRAFT_RATE_LIMIT_ERROR,
  IMAGE_INVALID_ERROR,
  IMAGE_MISSING_ERROR,
  IMAGE_SAVE_ERROR,
  IMAGE_TYPE_ERROR,
  UPLOAD_RATE_LIMIT_ERROR,
  imageTooLargeMessage,
} from './messages.js';
import {
  DRAFTS_PER_HOUR,
  HOUR_MS,
  UPLOADS_PER_HOUR,
  createWindowLimiter,
  type WindowLimiter,
} from './rate-limit.js';
import {
  checkProductUrl,
  clearDealImage,
  createDraft,
  getDeal,
  listDeals,
  openDealImage,
  setDealImage,
  submitDraft,
  updateDraft,
} from './service.js';
import type { DealStatus } from './status.js';
import { SIGN_IN_REQUIRED } from '../auth/messages.js';
import type { SessionDeps } from '../auth/service.js';
import { removeStoredImage, writeStoredImage } from '../uploads/files.js';
import { reencodeImage } from '../uploads/image.js';
import { detectImageKind } from '../uploads/magic.js';
import { parseCheckBody, parseDealBody, parseDealId, parseStatusFilter } from './validation.js';

export type DealRouteDeps = SessionDeps & {
  cookieName: string;
  cookieSecure: boolean;
  amazonTag: string;
  shortLinkHosts: readonly string[];
  uploadDir: string;
  maxUploadBytes: number;
  draftLimiter?: WindowLimiter;
  uploadLimiter?: WindowLimiter;
};

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
    if (error instanceof DealStatusTransitionError) {
      return reply.code(409).send({ error: 'This deal can no longer be changed.' });
    }
    throw error;
  }
}

function tooMany(reply: FastifyReply, retryAfterSeconds: number, message: string) {
  reply.header('retry-after', String(retryAfterSeconds));
  return reply.code(429).send({ error: message });
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

export function registerDealRoutes(app: FastifyInstance, deps: DealRouteDeps): void {
  const guard = requireSession(deps);
  const draftLimiter =
    deps.draftLimiter ?? createWindowLimiter({ limit: DRAFTS_PER_HOUR, windowMs: HOUR_MS });
  const uploadLimiter =
    deps.uploadLimiter ?? createWindowLimiter({ limit: UPLOADS_PER_HOUR, windowMs: HOUR_MS });
  const linkOptions = { amazonTag: deps.amazonTag, shortLinkHosts: deps.shortLinkHosts };

  app.get('/api/deals/config', { preHandler: guard }, async (request, reply) => {
    if (request.authUser === null) {
      return reply.code(401).send({ error: SIGN_IN_REQUIRED });
    }
    return {
      shortLinkHosts: deps.shortLinkHosts,
      maxUploadMb: deps.maxUploadBytes / (1024 * 1024),
    };
  });

  app.post('/api/deals/check-url', { preHandler: guard }, async (request, reply) => {
    const user = request.authUser;
    if (user === null) {
      return reply.code(401).send({ error: SIGN_IN_REQUIRED });
    }
    const parsed = parseCheckBody(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error, fields: parsed.fields });
    }
    return handle(reply, () => checkProductUrl(deps.db, user, parsed.value, deps.amazonTag));
  });

  app.post('/api/deals', { preHandler: guard }, async (request, reply) => {
    const user = request.authUser;
    if (user === null) {
      return reply.code(401).send({ error: SIGN_IN_REQUIRED });
    }
    const parsed = parseDealBody(request.body, linkOptions);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error, fields: parsed.fields });
    }
    const limit = draftLimiter.check(user.id, deps.now().getTime());
    if (!limit.allowed) {
      return tooMany(reply, limit.retryAfterSeconds, DRAFT_RATE_LIMIT_ERROR);
    }
    return handle(reply, async () => {
      const deal = await createDraft(deps.db, user, parsed.value, deps.amazonTag);
      return reply.code(201).send({ deal });
    });
  });

  app.get('/api/deals', { preHandler: guard }, async (request, reply) => {
    const user = request.authUser;
    if (user === null) {
      return reply.code(401).send({ error: SIGN_IN_REQUIRED });
    }
    const status = parseStatusFilter(readQuery(request.query, 'status'));
    if (status === 'invalid') {
      return reply.code(400).send({ error: 'That status is not recognised.' });
    }
    return handle(reply, async () => ({
      deals: await listDeals(deps.db, user, status as DealStatus | undefined),
    }));
  });

  app.get('/api/deals/:id', { preHandler: guard }, async (request, reply) => {
    const user = request.authUser;
    if (user === null) {
      return reply.code(401).send({ error: SIGN_IN_REQUIRED });
    }
    const id = parseDealId(readParam(request.params, 'id'));
    if (id === undefined) {
      return reply.code(404).send({ error: 'That deal was not found.' });
    }
    return handle(reply, async () => ({ deal: await getDeal(deps.db, user, id) }));
  });

  app.patch('/api/deals/:id', { preHandler: guard }, async (request, reply) => {
    const user = request.authUser;
    if (user === null) {
      return reply.code(401).send({ error: SIGN_IN_REQUIRED });
    }
    const id = parseDealId(readParam(request.params, 'id'));
    if (id === undefined) {
      return reply.code(404).send({ error: 'That deal was not found.' });
    }
    const parsed = parseDealBody(request.body, linkOptions);
    if (!parsed.ok) {
      return reply.code(400).send({ error: parsed.error, fields: parsed.fields });
    }
    return handle(reply, async () => ({
      deal: await updateDraft(deps.db, user, id, parsed.value, deps.amazonTag),
    }));
  });

  app.post('/api/deals/:id/submit', { preHandler: guard }, async (request, reply) => {
    const user = request.authUser;
    if (user === null) {
      return reply.code(401).send({ error: SIGN_IN_REQUIRED });
    }
    const id = parseDealId(readParam(request.params, 'id'));
    if (id === undefined) {
      return reply.code(404).send({ error: 'That deal was not found.' });
    }
    return handle(reply, async () => ({
      deal: await submitDraft(deps.db, user, id, deps.now()),
    }));
  });

  app.get('/api/deals/:id/image', { preHandler: guard }, async (request, reply) => {
    const user = request.authUser;
    if (user === null) {
      return reply.code(401).send({ error: SIGN_IN_REQUIRED });
    }
    const id = parseDealId(readParam(request.params, 'id'));
    if (id === undefined) {
      return reply.code(404).send({ error: 'That deal was not found.' });
    }
    return handle(reply, async () => {
      const image = await openDealImage(deps.db, user, id, deps.uploadDir);
      return reply
        .type(image.mime)
        .header('content-disposition', 'inline')
        .header('cache-control', 'private, no-store')
        .send(image.bytes);
    });
  });

  app.delete('/api/deals/:id/image', { preHandler: guard }, async (request, reply) => {
    const user = request.authUser;
    if (user === null) {
      return reply.code(401).send({ error: SIGN_IN_REQUIRED });
    }
    const id = parseDealId(readParam(request.params, 'id'));
    if (id === undefined) {
      return reply.code(404).send({ error: 'That deal was not found.' });
    }
    return handle(reply, async () => {
      const previous = await clearDealImage(deps.db, user, id);
      await removeStoredImage(deps.uploadDir, previous);
      return reply.code(204).send();
    });
  });

  app.register(async (scope) => {
    await scope.register(multipart, {
      throwFileSizeLimit: true,
      limits: {
        files: 1,
        fileSize: deps.maxUploadBytes,
        fields: 2,
        parts: 5,
      },
    });
    scope.post(
      '/api/deals/:id/image',
      { preHandler: guard, bodyLimit: deps.maxUploadBytes + 64 * 1024 },
      async (request, reply) => {
        const user = request.authUser;
        if (user === null) {
          return reply.code(401).send({ error: SIGN_IN_REQUIRED });
        }
        const id = parseDealId(readParam(request.params, 'id'));
        if (id === undefined) {
          return reply.code(404).send({ error: 'That deal was not found.' });
        }
        const limit = uploadLimiter.check(user.id, deps.now().getTime());
        if (!limit.allowed) {
          return tooMany(reply, limit.retryAfterSeconds, UPLOAD_RATE_LIMIT_ERROR);
        }
        let filename: string | undefined;
        try {
          const uploaded = await request.file();
          if (uploaded === undefined) {
            return reply.code(400).send({ error: IMAGE_MISSING_ERROR });
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
          const saved = await setDealImage(deps.db, user, id, {
            filename,
            mime: encoded.mime,
          });
          if (saved.previousFilename !== null && saved.previousFilename !== filename) {
            await removeStoredImage(deps.uploadDir, saved.previousFilename);
          }
          return reply.code(200).send({ deal: saved.deal });
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

function readParam(params: unknown, key: string): unknown {
  if (params === null || typeof params !== 'object') {
    return undefined;
  }
  return (params as Record<string, unknown>)[key];
}

function readQuery(query: unknown, key: string): unknown {
  if (query === null || typeof query !== 'object') {
    return undefined;
  }
  return (query as Record<string, unknown>)[key];
}
