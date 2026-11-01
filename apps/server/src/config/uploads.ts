import { accessSync, constants, mkdirSync, statSync } from 'node:fs';

export function uploadDirError(dir: string): string {
  return `UPLOAD_DIR is not writable: ${dir}. Create this directory and give the server user write access. If Compose mounted a root-owned volume on this path, chown it to the node user.`;
}

export function ensureUploadDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    if (!statSync(dir).isDirectory()) {
      throw new Error(uploadDirError(dir));
    }
    accessSync(dir, constants.W_OK);
  } catch (error) {
    if (error instanceof Error && error.message === uploadDirError(dir)) {
      throw error;
    }
    throw new Error(uploadDirError(dir), { cause: error });
  }
}
