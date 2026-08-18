import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

// Wrapped by hand rather than with promisify: promisify resolves to scrypt's
// three-argument overload, which drops the cost parameters entirely.
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/**
 * scrypt from the standard library rather than argon2 or bcrypt: both of those
 * are native modules that have to compile on every machine and CI image, and
 * scrypt is a memory-hard KDF that is entirely adequate here.
 *
 * Parameters are stored alongside the hash so they can be raised later without
 * invalidating existing passwords.
 */
const N = 16_384;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export const MIN_PASSWORD_LENGTH = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(password, salt, KEY_LENGTH, { N, r, p });
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, storedN, storedR, storedP, salt, expected] = parts;
  const expectedKey = Buffer.from(expected, "base64");

  let actual: Buffer;
  try {
    actual = await scrypt(password, Buffer.from(salt, "base64"), expectedKey.length, {
      N: Number(storedN),
      r: Number(storedR),
      p: Number(storedP),
    });
  } catch {
    return false;
  }

  // Lengths must match before timingSafeEqual, which throws otherwise.
  if (actual.length !== expectedKey.length) return false;
  return timingSafeEqual(actual, expectedKey);
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return "That password is too long.";
  return null;
}
