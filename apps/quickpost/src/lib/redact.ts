export function redactToken(text: string, token: string | undefined): string {
  if (token === undefined || token.length < 8) {
    return text;
  }
  return text.split(token).join('[Redacted]');
}
