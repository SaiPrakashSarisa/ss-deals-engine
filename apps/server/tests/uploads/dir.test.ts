import { access, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureUploadDir, uploadDirError } from '../../src/config/uploads.js';

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ss-upload-dir-'));
  created.push(dir);
  return dir;
}

describe('ensureUploadDir', () => {
  afterEach(async () => {
    await Promise.all(created.splice(0).map((dir) => chmod(dir, 0o755).catch(() => undefined)));
  });

  it('creates a missing directory and leaves it writable', async () => {
    const parent = await tempDir();
    const dir = path.join(parent, 'uploads');
    ensureUploadDir(dir);
    await writeFile(path.join(dir, 'probe'), 'ok');
    await access(path.join(dir, 'probe'));
  });

  it('names the path when the directory cannot be created or written', async () => {
    const parent = await tempDir();
    const filePath = path.join(parent, 'not-a-directory');
    await writeFile(filePath, 'file');
    expect(() => ensureUploadDir(filePath)).toThrow(uploadDirError(filePath));

    const locked = path.join(parent, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o555);
    created.push(locked);
    expect(() => ensureUploadDir(locked)).toThrow(uploadDirError(locked));
    expect(uploadDirError(locked)).toContain('chown it to the node user');
  });
});
