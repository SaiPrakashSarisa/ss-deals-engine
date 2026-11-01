import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

const entrySchema = z
  .object({
    asin: z.string().regex(/^[A-Z0-9]{10}$/),
    timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    message_id: z.union([z.number().int().positive(), z.literal('uncertain')]),
    mode: z.enum(['text', 'photo']).optional(),
    link: z.enum(['tagged', 'short']).optional(),
  })
  .strict();

const fileSchema = z
  .object({
    entries: z.array(entrySchema),
  })
  .strict();

export type PostedEntry = z.infer<typeof entrySchema>;

export class PostedLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async read(): Promise<PostedEntry[]> {
    return this.enqueue(() => this.readFile());
  }

  async append(entry: PostedEntry): Promise<void> {
    await this.enqueue(async () => {
      const entries = await this.readFile();
      entries.push(entry);
      await writeAtomic(this.filePath, `${JSON.stringify({ entries }, null, 2)}\n`);
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readFile(): Promise<PostedEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        return [];
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('posted.json is not a valid post log');
    }

    const result = fileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error('posted.json is not a valid post log');
    }
    return result.data.entries;
  }
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
