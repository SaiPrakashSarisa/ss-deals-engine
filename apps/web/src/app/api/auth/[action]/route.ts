import { NextResponse } from 'next/server';
import { apiUrl } from '../../../../lib/session';

const METHODS: Record<string, string> = {
  login: 'POST',
  logout: 'POST',
  me: 'GET',
  'change-password': 'POST',
};

const BODY_LIMIT = 16 * 1024;

type RouteContext = {
  params: Promise<{ action: string }>;
};

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { action } = await context.params;
  const method = METHODS[action];
  if (method === undefined) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  if (request.method !== method) {
    return NextResponse.json({ error: 'Not found.' }, { status: 405 });
  }

  const headers = new Headers();
  copyHeader(request.headers, headers, 'content-type');
  copyHeader(request.headers, headers, 'cookie');
  copyHeader(request.headers, headers, 'origin');
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) {
    headers.set('x-forwarded-for', forwarded);
  }

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await request.text() : undefined;
  if (body !== undefined && body.length > BODY_LIMIT) {
    return NextResponse.json({ error: 'Request is too large.' }, { status: 413 });
  }

  const upstream = await fetch(`${apiUrl()}/api/auth/${action}`, {
    method,
    headers,
    body,
    cache: 'no-store',
    redirect: 'manual',
  });

  const responseHeaders = new Headers();
  copyHeader(upstream.headers, responseHeaders, 'content-type');
  copyHeader(upstream.headers, responseHeaders, 'retry-after');
  responseHeaders.set('cache-control', 'no-store');
  for (const cookie of readSetCookies(upstream.headers)) {
    responseHeaders.append('set-cookie', cookie);
  }

  const status = upstream.status;
  const upstreamBody = status === 204 || status === 304 ? null : await upstream.text();
  return new NextResponse(upstreamBody, {
    status,
    headers: responseHeaders,
  });
}

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name);
  if (value !== null) {
    to.set(name, value);
  }
}

function readSetCookies(headers: Headers): string[] {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single === null ? [] : [single];
}
