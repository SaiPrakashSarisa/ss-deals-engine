import { NextResponse } from 'next/server';
import { apiUrl } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_PROXY_BYTES = 8 * 1024 * 1024;

type RouteContext = {
  params: Promise<{ path?: string[] }>;
};

export function GET(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function POST(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

export function DELETE(request: Request, context: RouteContext): Promise<Response> {
  return proxy(request, context);
}

async function proxy(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  if (path?.some((part) => part === '.' || part === '..' || part.includes('\\'))) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }
  const suffix =
    path === undefined || path.length === 0 ? '' : `/${path.map(encodeURIComponent).join('/')}`;
  const query = new URL(request.url).search;
  const target = `${apiUrl()}/api/deals${suffix}${query}`;

  const headers = new Headers();
  copyHeader(request.headers, headers, 'content-type');
  copyHeader(request.headers, headers, 'cookie');
  copyHeader(request.headers, headers, 'origin');
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded !== null) {
    headers.set('x-forwarded-for', forwarded);
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
  if (body !== undefined && body.length > MAX_PROXY_BYTES) {
    return NextResponse.json({ error: 'This image is too large.' }, { status: 413 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return NextResponse.json(
      { error: 'The deal service is not available. Try again.' },
      { status: 502 },
    );
  }

  const responseHeaders = new Headers();
  copyHeader(upstream.headers, responseHeaders, 'content-type');
  copyHeader(upstream.headers, responseHeaders, 'retry-after');
  copyHeader(upstream.headers, responseHeaders, 'content-disposition');
  responseHeaders.set('cache-control', 'no-store');
  for (const cookie of readSetCookies(upstream.headers)) {
    responseHeaders.append('set-cookie', cookie);
  }

  if (upstream.status === 204 || upstream.status === 304) {
    return new NextResponse(null, { status: upstream.status, headers: responseHeaders });
  }
  const bytes = await upstream.arrayBuffer();
  return new NextResponse(bytes, { status: upstream.status, headers: responseHeaders });
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
