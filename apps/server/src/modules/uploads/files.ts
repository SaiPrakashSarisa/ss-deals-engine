import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STORED_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

export function resolveStored(uploadDir: string, filename: string): string | undefined {
  if (!STORED_NAME.test(filename)) {
    return undefined;
  }
  const root = path.resolve(uploadDir);
  const full = path.resolve(root, filename);
  if (full !== path.join(root, filename)) {
    return undefined;
  }
  return full;
}

export async function writeStoredImage(
  uploadDir: string,
  extension: 'jpg' | 'png' | 'webp',
  bytes: Buffer,
): Promise<string> {
  const root = path.resolve(uploadDir);
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const filename = `${randomBytes(16).toString('hex')}.${extension}`;
    try {
      await writeFile(path.join(root, filename), bytes, { flag: 'wx' });
      return filename;
    } catch (error) {
      if (attempt === 1 || !isAlreadyExists(error)) {
        throw error;
      }
    }
  }
  throw new Error('image file name collided');
}

export async function readStoredImage(
  uploadDir: string,
  filename: string,
): Promise<Buffer | undefined> {
  const full = resolveStored(uploadDir, filename);
  if (full === undefined) {
    return undefined;
  }
  try {
    return await readFile(full);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function removeStoredImage(uploadDir: string, filename: string | null): Promise<void> {
  if (filename === null) {
    return;
  }
  const full = resolveStored(uploadDir, filename);
  if (full === undefined) {
    return;
  }
  await rm(full, { force: true });
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
