import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const DUMMY_SALT = Buffer.alloc(SALT_BYTES, 1);

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

type ScryptParams = {
  N: number;
  r: number;
  p: number;
};

type StoredPassword = {
  params: ScryptParams;
  salt: Buffer;
  hash: Buffer;
};

export function passwordPolicyError(password: string): string | undefined {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return undefined;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return encodeStored({
    params: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    salt,
    hash,
  });
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = stored === null ? undefined : parseStored(stored);
  const salt = parsed?.salt ?? DUMMY_SALT;
  const params = parsed?.params ?? { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  const actual = await derive(password, salt, params);
  const expected = parsed?.hash ?? Buffer.alloc(KEY_LENGTH);
  if (parsed === undefined || actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function encodeStored(stored: StoredPassword): string {
  return [
    'scrypt',
    String(stored.params.N),
    String(stored.params.r),
    String(stored.params.p),
    stored.salt.toString('base64url'),
    stored.hash.toString('base64url'),
  ].join('$');
}

function parseStored(stored: string): StoredPassword | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return undefined;
  }
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltPart = parts[4];
  const hashPart = parts[5];
  if (
    saltPart === undefined ||
    hashPart === undefined ||
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    N <= 1 ||
    r <= 0 ||
    p <= 0
  ) {
    return undefined;
  }
  const salt = Buffer.from(saltPart, 'base64url');
  const hash = Buffer.from(hashPart, 'base64url');
  if (salt.length === 0 || hash.length === 0) {
    return undefined;
  }
  return { params: { N, r, p }, salt, hash };
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_LENGTH, params, (error, key) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}
