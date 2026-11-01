import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostedLog, type PostedEntry } from '../src/store/posted.js';

describe('PostedLog', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('round-trips entries and leaves no temporary file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quickpost-log-'));
    directories.push(dir);
    const log = new PostedLog(join(dir, 'posted.json'));
    const entry: PostedEntry = {
      asin: 'B0CABCDEFG',
      timestamp: '2026-10-31T10:00:00.000Z',
      message_id: 5,
    };

    expect(await log.read()).toEqual([]);
    await log.append(entry);

    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await log.read()).toEqual([entry]);
  });

  it('round-trips the post mode and which link was shown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quickpost-log-'));
    directories.push(dir);
    const log = new PostedLog(join(dir, 'posted.json'));
    const entry: PostedEntry = {
      asin: 'B0CABCDEFG',
      timestamp: '2026-10-31T10:00:00.000Z',
      message_id: 5,
      mode: 'photo',
      link: 'short',
    };

    await log.append(entry);
    expect(await log.read()).toEqual([entry]);
  });

  it('appends concurrently without dropping entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quickpost-log-'));
    directories.push(dir);
    const log = new PostedLog(join(dir, 'posted.json'));
    const first: PostedEntry = {
      asin: 'B0TEST0001',
      timestamp: '2026-10-31T10:00:00.000Z',
      message_id: 1,
    };
    const second: PostedEntry = {
      asin: 'B0TEST0002',
      timestamp: '2026-10-31T10:00:01.000Z',
      message_id: 'uncertain',
    };

    await Promise.all([log.append(first), log.append(second)]);
    const asins = (await log.read()).map((entry) => entry.asin).sort();
    expect(asins).toEqual(['B0TEST0001', 'B0TEST0002']);
  });

  it('refuses a corrupt log instead of overwriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quickpost-log-'));
    directories.push(dir);
    const filePath = join(dir, 'posted.json');
    await writeFile(filePath, '{', 'utf8');
    const log = new PostedLog(filePath);

    await expect(log.read()).rejects.toThrow('posted.json is not a valid post log');
  });
});
