import type { FastifyReply, FastifyRequest } from 'fastify';
import { readCookie, sessionCookieHeader } from '../auth/cookies.js';
import { FORBIDDEN_ERROR, SIGN_IN_REQUIRED } from '../auth/messages.js';
import { touchSession, type SessionDeps } from '../auth/service.js';

export function requireAdmin(deps: SessionDeps & { cookieName: string; cookieSecure: boolean }) {
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
    request.authUser = {
      id: session.id,
      username: session.username,
      role: session.role,
      displayName: session.displayName,
    };
    reply.header(
      'set-cookie',
      sessionCookieHeader(deps.cookieName, token, {
        secure: deps.cookieSecure,
        maxAgeSeconds: session.maxAgeSeconds,
      }),
    );
    if (session.role !== 'owner') {
      await reply.code(403).send({ error: FORBIDDEN_ERROR });
    }
  };
}
