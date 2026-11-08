import { readFile } from 'node:fs/promises';
import { buildTaggedProductUrl } from '@ss-deals/core';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadConfig } from '../config/env.js';
import {
  affiliateLinks,
  channels,
  contentDrafts,
  deals,
  products,
  publications,
  users,
} from '../db/schema/index.js';
import type { Database } from '../lib/db.js';
import { createDb } from '../lib/db.js';
import { isEntrypoint } from '../lib/entrypoint.js';
import { createLogger } from '../lib/logger.js';

const entrySchema = z
  .object({
    asin: z.string().regex(/^[A-Z0-9]{10}$/),
    timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    message_id: z.union([z.number().int().positive(), z.literal('uncertain')]),
    mode: z.enum(['text', 'photo']).optional(),
    link: z.enum(['tagged', 'short']).optional(),
    title: z.string().optional(),
    channel: z.string().optional(),
  })
  .strict();

export type ImportEntry = z.infer<typeof entrySchema>;

export type ImportArgs = {
  file?: string;
  adminUsername?: string;
  dryRun: boolean;
};

export type ImportCounts = {
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
};

type ImportDb = Database['db'];

export function parseImportArgs(argv: readonly string[]): ImportArgs {
  let file: string | undefined;
  let adminUsername: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--file') {
      file = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith('--file=')) {
      file = arg.slice('--file='.length);
      continue;
    }
    if (arg === '--admin-username') {
      adminUsername = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith('--admin-username=')) {
      adminUsername = arg.slice('--admin-username='.length);
    }
  }
  return { file, adminUsername, dryRun };
}

export function parsePostedLog(raw: string): { entries: ImportEntry[]; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('posted.json is not a valid post log');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error('posted.json is not a valid post log');
  }
  const entries: ImportEntry[] = [];
  const errors: string[] = [];
  for (const [index, item] of parsed.entries.entries()) {
    const result = entrySchema.safeParse(item);
    if (!result.success) {
      errors.push(`Entry ${index + 1}: not a valid post log entry.`);
      continue;
    }
    entries.push(result.data);
  }
  return { entries, errors };
}

function dealTitle(entry: ImportEntry): string {
  const title = entry.title?.trim() ?? '';
  if (title.length >= 1 && title.length <= 200) {
    return title;
  }
  return `Imported: ${entry.asin}`;
}

function channelName(entry: ImportEntry, fallback: string | null): string | undefined {
  const named = entry.channel?.trim() ?? '';
  if (named.length > 0) {
    return named;
  }
  const channel = fallback?.trim() ?? '';
  return channel.length > 0 ? channel : undefined;
}

export async function importPostedHistory(
  db: ImportDb,
  input: {
    entries: readonly ImportEntry[];
    adminUserId: string;
    amazonTag: string;
    defaultChannel: string | null;
    dryRun: boolean;
  },
): Promise<ImportCounts> {
  const counts: ImportCounts = { imported: 0, skipped: 0, failed: 0, errors: [] };
  const seen = new Set<string>();
  for (const [index, entry] of input.entries.entries()) {
    const label = `Entry ${index + 1} (${entry.asin})`;
    const channel = channelName(entry, input.defaultChannel);
    if (channel === undefined) {
      counts.failed += 1;
      counts.errors.push(`${label}: the Telegram channel is not configured.`);
      continue;
    }
    if (seen.has(entry.asin)) {
      counts.skipped += 1;
      continue;
    }
    try {
      const wrote = await db.transaction(async (tx) => {
        const [already] = await tx
          .select({ id: publications.id })
          .from(publications)
          .innerJoin(products, eq(products.id, publications.productId))
          .where(
            and(
              eq(products.source, 'amazon'),
              eq(products.externalId, entry.asin),
              eq(publications.status, 'published'),
            ),
          )
          .limit(1);
        if (already !== undefined) {
          return false;
        }
        if (input.dryRun) {
          return true;
        }
        const tagged = buildTaggedProductUrl(entry.asin, input.amazonTag);
        await tx
          .insert(channels)
          .values({ platform: 'telegram', name: channel, username: channel, isActive: true })
          .onConflictDoNothing({ target: [channels.platform, channels.username] });
        const [storedChannel] = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(and(eq(channels.platform, 'telegram'), eq(channels.username, channel)))
          .limit(1);
        if (storedChannel === undefined) {
          throw new Error('channel missing');
        }
        const [product] = await tx
          .insert(products)
          .values({
            source: 'amazon',
            externalId: entry.asin,
            canonicalUrl: tagged,
            title: dealTitle(entry),
          })
          .onConflictDoUpdate({
            target: [products.source, products.externalId],
            set: { canonicalUrl: tagged },
          })
          .returning({ id: products.id });
        if (product === undefined) {
          throw new Error('product missing');
        }
        const [link] = await tx
          .insert(affiliateLinks)
          .values({
            productId: product.id,
            platform: 'amazon',
            originalUrl: `https://www.amazon.in/dp/${entry.asin}`,
            affiliateUrl: tagged,
            affiliateTag: input.amazonTag,
            verification: 'tag_appended',
            validationStatus: 'structure_ok',
            createdBy: input.adminUserId,
          })
          .returning({ id: affiliateLinks.id });
        if (link === undefined) {
          throw new Error('link missing');
        }
        const [deal] = await tx
          .insert(deals)
          .values({
            productId: product.id,
            linkId: link.id,
            status: 'published',
            title: dealTitle(entry),
            pricePaise: 100,
            highlights: [],
            sourceNote: 'quickpost_import',
            createdBy: input.adminUserId,
          })
          .returning({ id: deals.id });
        if (deal === undefined) {
          throw new Error('deal missing');
        }
        const [draft] = await tx
          .insert(contentDrafts)
          .values({
            dealId: deal.id,
            version: 1,
            bodyHtml: 'Imported from quick-post',
            source: 'manual_edit',
            isCurrent: true,
          })
          .returning({ id: contentDrafts.id });
        if (draft === undefined) {
          throw new Error('draft missing');
        }
        await tx.insert(publications).values({
          dealId: deal.id,
          productId: product.id,
          channelId: storedChannel.id,
          contentDraftId: draft.id,
          status: 'published',
          mode: entry.mode ?? 'text',
          linkKind: entry.link ?? 'tagged',
          origin: 'quickpost_import',
          postedPricePaise: null,
          externalMessageId:
            entry.message_id === 'uncertain' ? 'uncertain' : String(entry.message_id),
          publishedAt: new Date(entry.timestamp),
        });
        return true;
      });
      seen.add(entry.asin);
      if (wrote) {
        counts.imported += 1;
      } else {
        counts.skipped += 1;
      }
    } catch {
      counts.failed += 1;
      counts.errors.push(`${label}: could not be imported.`);
    }
  }
  return counts;
}

async function findAdmin(db: ImportDb, username: string): Promise<{ id: string }> {
  const [user] = await db
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (user === undefined || !user.isActive || user.role !== 'owner') {
    throw new Error(`No admin named ${username}.`);
  }
  return user;
}

export async function runImport(argv: readonly string[]): Promise<number> {
  const args = parseImportArgs(argv);
  if (args.file === undefined || args.file.trim() === '' || args.adminUsername === undefined) {
    console.error(
      'Usage: pnpm --filter @ss-deals/server import:quickpost --file <posted.json> --admin-username <name> [--dry-run]',
    );
    return 1;
  }
  let parsed: { entries: ImportEntry[]; errors: string[] };
  try {
    parsed = parsePostedLog(await readFile(args.file, 'utf8'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'posted.json is not a valid post log');
    return 1;
  }
  const config = loadConfig();
  const { pool, db } = createDb(config.DATABASE_URL, createLogger(config));
  try {
    const admin = await findAdmin(db, args.adminUsername);
    const result = await importPostedHistory(db, {
      entries: parsed.entries,
      adminUserId: admin.id,
      amazonTag: config.AMAZON_TAG,
      defaultChannel: config.TELEGRAM_CHANNEL,
      dryRun: args.dryRun,
    });
    console.log(`${args.dryRun ? 'would import' : 'imported'}: ${result.imported}`);
    console.log(`skipped: ${result.skipped}`);
    console.log(`failed: ${result.failed + parsed.errors.length}`);
    for (const error of [...parsed.errors, ...result.errors]) {
      console.error(error);
    }
    return result.failed + parsed.errors.length > 0 ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The import could not be started.');
    return 1;
  } finally {
    await pool.end();
  }
}

if (isEntrypoint(import.meta.url)) {
  runImport(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'The import could not be started.');
      process.exitCode = 1;
    });
}
