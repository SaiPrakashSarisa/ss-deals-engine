export type TelegramButton = { text: string; url: string };

export type TelegramText = {
  chatId: string;
  text: string;
  previewEnabled: boolean;
  button?: TelegramButton;
};

export type TelegramPhoto = {
  chatId: string;
  caption: string;
  filename: string;
  mime: string;
  bytes: Uint8Array;
  button?: TelegramButton;
};

export type TelegramResult =
  | { kind: 'ok'; messageId: number }
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'rejected'; reason: string }
  | { kind: 'uncertain'; reason: string }
  | { kind: 'not_sent'; reason: string };

export interface TelegramClient {
  sendText(input: TelegramText): Promise<TelegramResult>;
  sendPhoto(input: TelegramPhoto): Promise<TelegramResult>;
}

export type TelegramFetch = (url: string, init: RequestInit) => Promise<Response>;

const PRE_SEND_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EHOSTUNREACH']);

export function redactSecret(value: string, secret: string | null | undefined): string {
  if (secret === undefined || secret === null || secret.length < 4 || !value.includes(secret)) {
    return value;
  }
  return value.split(secret).join('[Redacted]');
}

export function createTelegramClient(options: {
  token: string;
  timeoutMs: number;
  fetchImpl?: TelegramFetch;
}): TelegramClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `https://api.telegram.org/bot${options.token}`;

  async function call(
    method: string,
    body: NonNullable<RequestInit['body']>,
    contentType?: string,
  ): Promise<TelegramResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const headers = contentType === undefined ? undefined : { 'content-type': contentType };
      const response = await fetchImpl(`${base}/${method}`, {
        method: 'POST',
        body,
        headers,
        signal: controller.signal,
      });
      return await classifyResponse(response, options.token);
    } catch (error) {
      return classifyThrown(error, options.token);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    sendText(input) {
      const payload: Record<string, unknown> = {
        chat_id: input.chatId,
        text: input.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: !input.previewEnabled },
      };
      if (input.button !== undefined) {
        payload.reply_markup = keyboard(input.button);
      }
      return call('sendMessage', JSON.stringify(payload), 'application/json');
    },
    sendPhoto(input) {
      const form = new FormData();
      form.set('chat_id', input.chatId);
      form.set('caption', input.caption);
      form.set('parse_mode', 'HTML');
      form.set('photo', new Blob([copiedBytes(input.bytes)], { type: input.mime }), input.filename);
      if (input.button !== undefined) {
        form.set('reply_markup', JSON.stringify(keyboard(input.button)));
      }
      return call('sendPhoto', form);
    },
  };
}

function copiedBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function keyboard(button: TelegramButton): { inline_keyboard: TelegramButton[][] } {
  return { inline_keyboard: [[button]] };
}

async function classifyResponse(response: Response, token: string): Promise<TelegramResult> {
  const body = (await response.json().catch(() => null)) as {
    ok?: unknown;
    result?: { message_id?: unknown };
    description?: unknown;
    error_code?: unknown;
    parameters?: { retry_after?: unknown };
  } | null;
  if (body === null) {
    return { kind: 'uncertain', reason: 'Telegram returned a response that could not be read.' };
  }
  if (response.status === 429 || body.error_code === 429) {
    const fromBody = body.parameters?.retry_after;
    const header = Number(response.headers.get('retry-after'));
    const retryAfterSeconds =
      typeof fromBody === 'number' && Number.isFinite(fromBody)
        ? Math.max(1, Math.ceil(fromBody))
        : Number.isFinite(header) && header > 0
          ? Math.ceil(header)
          : 1;
    return { kind: 'rate_limited', retryAfterSeconds };
  }
  if (response.ok && body.ok === true && typeof body.result?.message_id === 'number') {
    return { kind: 'ok', messageId: body.result.message_id };
  }
  const reason = redactSecret(reasonText(body.description), token);
  if (response.status >= 500 || (typeof body.error_code === 'number' && body.error_code >= 500)) {
    return { kind: 'uncertain', reason };
  }
  if (response.status >= 400 || (typeof body.error_code === 'number' && body.error_code >= 400)) {
    return { kind: 'rejected', reason };
  }
  return { kind: 'uncertain', reason };
}

function classifyThrown(error: unknown, token: string): TelegramResult {
  const name = errorName(error);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'uncertain', reason: 'The request to Telegram timed out.' };
  }
  const code = errorCode(error);
  const reason = redactSecret(
    error instanceof Error ? error.message : 'Telegram could not be reached.',
    token,
  );
  if (code !== undefined && PRE_SEND_CODES.has(code)) {
    return { kind: 'not_sent', reason: 'Telegram could not be reached before the post was sent.' };
  }
  return { kind: 'uncertain', reason };
}

function reasonText(value: unknown): string {
  const text =
    typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : 'Telegram refused the post.';
  return text.slice(0, 300);
}

function errorName(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
  ) {
    return error.name;
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if ('cause' in error) {
    return errorCode(error.cause);
  }
  return undefined;
}
