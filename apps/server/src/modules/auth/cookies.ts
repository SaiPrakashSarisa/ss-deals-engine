export function readCookie(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key !== name) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

export function sessionCookieHeader(
  name: string,
  token: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  return serializeCookie(name, token, options);
}

export function clearSessionCookieHeader(name: string, secure: boolean): string {
  return serializeCookie(name, '', { secure, maxAgeSeconds: 0 });
}

function serializeCookie(
  name: string,
  value: string,
  options: { secure: boolean; maxAgeSeconds: number },
): string {
  const parts = [
    `${name}=${value}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) {
    parts.push('Secure');
  }
  return parts.join('; ');
}
