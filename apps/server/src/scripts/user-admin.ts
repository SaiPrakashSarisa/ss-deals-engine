import { eq } from 'drizzle-orm';
import { loadConfig } from '../config/env.js';
import { users } from '../db/schema/index.js';
import { isEntrypoint } from '../lib/entrypoint.js';
import { createDb } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';
import { hashPassword, passwordPolicyError } from '../modules/auth/password.js';
import { revokeUserSessions } from '../modules/auth/service.js';

type Command = 'create' | 'set-password' | 'set-name' | 'deactivate';

type AdminArgs = {
  username?: string;
  role?: string;
  name?: string;
  nameProvided: boolean;
  passwordOnCommandLine: boolean;
};

export const DISPLAY_NAME_MAX = 60;

export function parseUserAdminArgs(argv: readonly string[]): AdminArgs {
  let username: string | undefined;
  let role: string | undefined;
  let name: string | undefined;
  let nameProvided = false;
  let passwordOnCommandLine = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--password' || arg.startsWith('--password=')) {
      passwordOnCommandLine = true;
      continue;
    }
    if (arg === '--username') {
      username = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--username=')) {
      username = arg.slice('--username='.length);
      continue;
    }
    if (arg === '--role') {
      role = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--role=')) {
      role = arg.slice('--role='.length);
      continue;
    }
    if (arg === '--name') {
      name = argv[index + 1];
      nameProvided = true;
      index += 1;
      continue;
    }
    if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
      nameProvided = true;
    }
  }

  return { username, role, name, nameProvided, passwordOnCommandLine };
}

export function normalizeDisplayName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (name.length === 0) {
    throw new Error('Name cannot be blank.');
  }
  if (name.length > DISPLAY_NAME_MAX) {
    throw new Error(`Name must be at most ${DISPLAY_NAME_MAX} characters.`);
  }
  return name;
}

export function normalizeUsername(value: string | undefined): string {
  const username = value?.trim() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(username)) {
    throw new Error(
      'Username must be 1 to 64 characters and use letters, numbers, ".", "_" or "-", starting with a letter or number.',
    );
  }
  return username;
}

async function main(): Promise<void> {
  const command = readCommand(process.argv[2]);
  const args = parseUserAdminArgs(process.argv.slice(3));
  if (args.passwordOnCommandLine) {
    throw new Error('Do not pass the password on the command line. The script will prompt for it.');
  }

  const username = normalizeUsername(args.username);
  const config = loadConfig();
  const logger = createLogger(config);
  const { pool, db } = createDb(config.DATABASE_URL, logger);

  try {
    if (command === 'create') {
      const role = readRole(args.role);
      const displayName = args.nameProvided ? normalizeDisplayName(args.name) : null;
      const password = await readNewPassword();
      const passwordHash = await hashPassword(password);
      try {
        await db
          .insert(users)
          .values({ username, role, displayName, passwordHash, isActive: true });
      } catch (error) {
        if (postgresCode(error) === '23505') {
          throw new Error(`The username ${username} is already taken.`, { cause: error });
        }
        throw error;
      }
      console.log(`Created ${role} ${username}.`);
      return;
    }

    const user = await findUser(db, username);
    if (command === 'set-name') {
      if (!args.nameProvided) {
        throw new Error('Pass --name with the name to show.');
      }
      const displayName = normalizeDisplayName(args.name);
      await db.update(users).set({ displayName }).where(eq(users.id, user.id));
      console.log(`Updated the name for ${username}.`);
      return;
    }
    if (command === 'deactivate') {
      await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
      await revokeUserSessions({ db, now: () => new Date() }, user.id);
      console.log(`Deactivated ${username} and signed out their sessions.`);
      return;
    }

    const password = await readNewPassword();
    const passwordHash = await hashPassword(password);
    await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await revokeUserSessions({ db, now: () => new Date() }, user.id);
    console.log(`Updated the password for ${username} and signed out their sessions.`);
  } finally {
    await pool.end();
  }
}

function readCommand(value: string | undefined): Command {
  if (
    value === 'create' ||
    value === 'set-password' ||
    value === 'set-name' ||
    value === 'deactivate'
  ) {
    return value;
  }
  throw new Error('Usage: user:create, user:set-password, user:set-name, or user:deactivate.');
}

function readRole(value: string | undefined): 'owner' | 'clerk' {
  if (value === 'owner' || value === 'clerk') {
    return value;
  }
  throw new Error('Role must be owner or clerk.');
}

async function findUser(
  db: ReturnType<typeof createDb>['db'],
  username: string,
): Promise<{ id: string }> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  if (user === undefined) {
    throw new Error(`No user named ${username}.`);
  }
  return user;
}

async function readNewPassword(): Promise<string> {
  for (;;) {
    const password = await promptHidden('Password: ');
    const policy = passwordPolicyError(password);
    if (policy !== undefined) {
      console.error(policy);
      continue;
    }
    const repeated = await promptHidden('Repeat password: ');
    if (password !== repeated) {
      console.error('Passwords did not match.');
      continue;
    }
    return password;
  }
}

export async function promptHidden(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run this command in a terminal so the password stays off the command line.');
  }

  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  const chars: string[] = [];

  try {
    return await new Promise((resolve, reject) => {
      const onData = (chunk: string) => {
        if (chunk === '\u0003') {
          process.stdout.write('\n');
          reject(new Error('Password prompt cancelled.'));
          return;
        }
        if (chunk === '\r' || chunk === '\n') {
          process.stdout.write('\n');
          process.stdin.off('data', onData);
          resolve(chars.join(''));
          return;
        }
        if (chunk === '\u007f' || chunk === '\b') {
          chars.pop();
          return;
        }
        if (chunk.startsWith('\u001b')) {
          return;
        }
        chars.push(chunk);
      };
      process.stdin.on('data', onData);
    });
  } finally {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (
    current !== null &&
    current !== undefined &&
    typeof current === 'object' &&
    !seen.has(current)
  ) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'user command failed';
    console.error(message);
    process.exit(1);
  });
}
