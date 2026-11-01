import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { clearSessionCookieHeader, readCookie, sessionCookieHeader } from './cookies.js';
import {
  CSRF_ERROR,
  FORBIDDEN_ERROR,
  LOGIN_ERROR,
  LOGIN_FIELDS_ERROR,
  RATE_LIMIT_ERROR,
  SIGN_IN_REQUIRED,
} from './messages.js';
import { createRateLimiter, type RateLimiter } from './rate-limit.js';
import {
  authenticate,
  revokeSession,
  touchSession,
  type AuthRole,
  type AuthUser,
} from './service.js';
import type { SessionDeps } from './service.js';

export const FAILURE_DELAY_MS = 250;

export type AuthRouteDeps = SessionDeps & {
  cookieName: string;
  cookieSecure: boolean;
  allowedOrigins: readonly string[];
  failureDelayMs?: number;
  enableTestRoutes?: boolean;
  rateLimiter?: RateLimiter;
  delay?: (ms: number) => Promise<void>;
};

declare module 'fastify' {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const limiter = deps.rateLimiter ?? createRateLimiter();
  const wait = deps.delay ?? delay;
  const failureDelayMs = deps.failureDelayMs ?? FAILURE_DELAY_MS;

  app.decorateRequest('authUser', null);

  app.addHook('onRequest', async (request, reply) => {
    if (!stateChanging(request.method)) {
      return;
    }
    if (!originAllowed(request.headers.origin, deps.allowedOrigins)) {
      return reply.code(403).send({ error: CSRF_ERROR });
    }
  });

  app.post('/api/auth/login', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = readLoginBody(request.body);
    if (parsed === undefined) {
      return reply.code(400).send({ error: LOGIN_FIELDS_ERROR });
    }

    const ip = request.ip;
    const nowMs = deps.now().getTime();
    const decision = limiter.check(parsed.username, ip, nowMs);
    if (!decision.allowed) {
      await wait(failureDelayMs);
      reply.header('retry-after', String(decision.retryAfterSeconds));
      return reply.code(429).send({ error: RATE_LIMIT_ERROR });
    }

    const opened = await authenticate(
      deps,
      parsed.username,
      parsed.password,
      headerValue(request.headers['user-agent']),
    );
    if (opened === undefined) {
      limiter.recordFailure(parsed.username, ip, nowMs);
      await wait(failureDelayMs);
      return reply.code(401).send({ error: LOGIN_ERROR });
    }

    limiter.clearUsername(parsed.username, ip);
    reply.header(
      'set-cookie',
      sessionCookieHeader(deps.cookieName, opened.token, {
        secure: deps.cookieSecure,
        maxAgeSeconds: opened.maxAgeSeconds,
      }),
    );
    return reply.code(200).send({
      user: { id: opened.id, username: opened.username, role: opened.role },
    });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const token = readCookie(request.headers.cookie, deps.cookieName);
    if (token !== undefined) {
      await revokeSession(deps, token);
    }
    reply.header('set-cookie', clearSessionCookieHeader(deps.cookieName, deps.cookieSecure));
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireUser(deps) }, async (request) => {
    const user = request.authUser;
    if (user === null) {
      return { error: SIGN_IN_REQUIRED };
    }
    return { id: user.id, username: user.username, role: user.role };
  });

  if (deps.enableTestRoutes === true) {
    app.get('/api/auth/test/user', { preHandler: requireUser(deps) }, async (request, reply) =>
      guardBody(request, reply),
    );
    app.get(
      '/api/auth/test/owner',
      { preHandler: requireRole(deps, 'owner') },
      async (request, reply) => guardBody(request, reply),
    );
    app.get(
      '/api/auth/test/clerk',
      { preHandler: requireRole(deps, 'clerk') },
      async (request, reply) => guardBody(request, reply),
    );
  }
}

export function originAllowed(
  origin: string | string[] | undefined,
  allowedOrigins: readonly string[],
): boolean {
  if (typeof origin !== 'string' || origin.length === 0) {
    return false;
  }
  return allowedOrigins.includes(origin);
}

export function testRoutesEnabled(nodeEnv: 'development' | 'test' | 'production'): boolean {
  return nodeEnv !== 'production';
}

function requireUser(deps: AuthRouteDeps) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.header('cache-control', 'no-store');
    const token = readCookie(request.headers.cookie, deps.cookieName);
    if (token === undefined) {
      await reply.code(401).send({ error: SIGN_IN_REQUIRED });
      return;
    }
    const session = await touchSession(deps, token);
    if (session === undefined) {
      await reply.code(401).send({ error: SIGN_IN_REQUIRED });
      return;
    }
    request.authUser = { id: session.id, username: session.username, role: session.role };
    reply.header(
      'set-cookie',
      sessionCookieHeader(deps.cookieName, token, {
        secure: deps.cookieSecure,
        maxAgeSeconds: session.maxAgeSeconds,
      }),
    );
  };
}

function requireRole(deps: AuthRouteDeps, role: AuthRole) {
  const authenticateUser = requireUser(deps);
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await authenticateUser(request, reply);
    if (reply.sent || request.authUser === null) {
      return;
    }
    if (request.authUser.role !== role) {
      await reply.code(403).send({ error: FORBIDDEN_ERROR });
    }
  };
}

function guardBody(
  request: FastifyRequest,
  reply: FastifyReply,
): { ok: true; role: AuthRole } | undefined {
  if (request.authUser === null) {
    void reply.code(401).send({ error: SIGN_IN_REQUIRED });
    return undefined;
  }
  return { ok: true, role: request.authUser.role };
}

function readLoginBody(body: unknown): { username: string; password: string } | undefined {
  if (body === null || typeof body !== 'object') {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const username = record.username;
  const password = record.password;
  if (typeof username !== 'string' || typeof password !== 'string') {
    return undefined;
  }
  const trimmed = username.trim();
  if (trimmed.length === 0 || password.length === 0) {
    return undefined;
  }
  return { username: trimmed, password };
}

function stateChanging(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
