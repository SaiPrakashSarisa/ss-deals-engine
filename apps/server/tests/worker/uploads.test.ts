import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyUploadDir } from '../../src/worker/main.js';
import {
  formatIstClock,
  publicationStatusLine,
  retryLastError,
} from '../../src/modules/publishing/status-line.js';

describe('upload folder check', () => {
  it('names the path when the folder cannot be read', async () => {
    const messages: string[] = [];
    const missing = path.join(tmpdir(), 'ss-deals-missing-uploads');
    await expect(
      verifyUploadDir(missing, {
        error: (message) => {
          messages.push(message);
        },
      }),
    ).resolves.toBe(false);
    expect(messages).toEqual([`uploads folder is not readable: ${missing}`]);

    const present = await mkdtemp(path.join(tmpdir(), 'ss-deals-uploads-'));
    await expect(verifyUploadDir(present, { error: () => undefined })).resolves.toBe(true);
    await rm(present, { recursive: true, force: true });
  });
});

describe('status lines', () => {
  const now = new Date('2026-11-08T08:45:00.000Z');

  it('formats the gap, the retry, and the daily-limit move', () => {
    expect(formatIstClock(new Date('2026-11-08T08:59:00.000Z'))).toBe('2:29 pm');
    expect(
      publicationStatusLine({
        status: 'queued',
        lastError: null,
        attempts: 0,
        scheduledFor: new Date('2026-11-08T08:45:00.000Z'),
        gapEnds: new Date('2026-11-08T08:59:00.000Z'),
        now,
      }),
    ).toBe('Waiting for the minimum gap (earliest 2:29 pm)');
    expect(
      publicationStatusLine({
        status: 'queued',
        lastError: retryLastError(new Date('2026-11-08T08:51:00.000Z'), 2, 'connection refused'),
        attempts: 1,
        scheduledFor: new Date('2026-11-08T08:45:00.000Z'),
        gapEnds: null,
        now,
      }),
    ).toBe('Retrying at 2:21 pm (attempt 2 of 3)');
    expect(
      publicationStatusLine({
        status: 'queued',
        lastError: "Waiting for tomorrow's limit",
        attempts: 0,
        scheduledFor: now,
        gapEnds: null,
        now,
      }),
    ).toBe("Waiting for tomorrow's limit");
    expect(
      publicationStatusLine({
        status: 'queued',
        lastError: 'moved:2026-11-08T08:45:00.000Z',
        attempts: 0,
        scheduledFor: new Date('2026-11-08T18:30:00.000Z'),
        gapEnds: null,
        now,
      }),
    ).toBe('Moved from 2:15 pm because the daily limit was full');
  });
});
