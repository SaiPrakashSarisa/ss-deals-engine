import { GrammyError, HttpError } from 'grammy';
import type { SendOutcome } from './types.js';

export function classifyTelegramError(error: unknown): SendOutcome {
  if (error instanceof GrammyError) {
    if (error.error_code === 429) {
      return { ok: false, reason: 'rate_limited', retryAfterSeconds: retryAfterSeconds(error) };
    }
    if (error.error_code >= 500) {
      return { ok: false, reason: 'uncertain' };
    }
    return { ok: false, reason: 'rejected', description: error.description };
  }
  if (error instanceof HttpError) {
    return { ok: false, reason: 'uncertain' };
  }
  return { ok: false, reason: 'uncertain' };
}

function retryAfterSeconds(error: GrammyError): number {
  const retryAfter = error.parameters.retry_after;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0) {
    return retryAfter;
  }
  return 1;
}
