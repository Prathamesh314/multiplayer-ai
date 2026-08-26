import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "../auth/password";
import type { CurrentUser } from "../auth/types";
import { isUniqueViolation, query, queryOne } from "../db/client";

/** The alphabet the connect_code CHECK allows: no I, O, 0 or 1 to misread. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function connectCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let index = 0; index < 8; index += 1) {
    out += CODE_ALPHABET[bytes[index] % CODE_ALPHABET.length];
  }
  return `PK-${out.slice(0, 4)}-${out.slice(4)}`;
}

type UserRow = {
  id: string;
  handle: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
};

const toUser = (row: UserRow): CurrentUser => ({
  id: row.id,
  handle: row.handle,
  email: row.email,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
});

export type CreateUserInput = {
  handle: string;
  email: string;
  displayName: string;
  password: string;
};

export type CreateUserResult =
  | { ok: true; user: CurrentUser }
  | { ok: false; field: "handle" | "email" | "password"; error: string };

export async function createUser(input: CreateUserInput): Promise<CreateUserResult> {
  const handle = input.handle.trim().toLowerCase();
  const email = input.email.trim();
  const displayName = input.displayName.trim() || handle;

  if (!/^[a-z0-9][a-z0-9_-]{1,38}$/.test(handle)) {
    return {
      ok: false,
      field: "handle",
      error: "Use 2–39 characters: lowercase letters, numbers, dashes or underscores.",
    };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, field: "email", error: "That does not look like an email address." };
  }

  const passwordHash = await hashPassword(input.password);

  // Retried because the code is random and unique: a collision is vanishingly
  // unlikely but not impossible, and it should not surface as a failed signup.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const row = await queryOne<UserRow>(
        `INSERT INTO users (handle, email, display_name, password_hash, connect_code)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, handle, email, display_name, avatar_url`,
        [handle, email, displayName, passwordHash, connectCode()],
      );
      return { ok: true, user: toUser(row!) };
    } catch (cause) {
      if (isUniqueViolation(cause, "users_handle_key")) {
        return { ok: false, field: "handle", error: "That handle is taken." };
      }
      if (isUniqueViolation(cause, "users_email_key")) {
        return { ok: false, field: "email", error: "That email is already registered." };
      }
      if (isUniqueViolation(cause, "users_connect_code_key")) continue;
      throw cause;
    }
  }

  throw new Error("Could not allocate a connect code.");
}

/**
 * Verifies a password against a handle or an email.
 *
 * The hash is compared even when no user matched, so a wrong handle and a wrong
 * password take the same time — otherwise the response time enumerates accounts.
 */
export async function authenticate(
  identifier: string,
  password: string,
): Promise<CurrentUser | null> {
  const trimmed = identifier.trim();

  const row = await queryOne<UserRow & { password_hash: string | null }>(
    `SELECT id, handle, email, display_name, avatar_url, password_hash
       FROM users
      WHERE deleted_at IS NULL AND (handle = $1 OR email = $1)`,
    [trimmed],
  );

  const stored =
    row?.password_hash ??
    // A valid-shaped hash of a value nothing will match.
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==";

  const matches = await verifyPassword(password, stored);
  return matches && row ? toUser(row) : null;
}

export async function connectCodeOf(userId: string): Promise<string | null> {
  const row = await queryOne<{ connect_code: string }>(
    `SELECT connect_code FROM users WHERE id = $1`,
    [userId],
  );
  return row?.connect_code ?? null;
}

export async function rotateConnectCode(userId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const row = await queryOne<{ connect_code: string }>(
        `UPDATE users SET connect_code = $2, connect_code_rotated_at = now()
          WHERE id = $1 RETURNING connect_code`,
        [userId, connectCode()],
      );
      if (row) return row.connect_code;
      throw new Error("No such user.");
    } catch (cause) {
      if (isUniqueViolation(cause, "users_connect_code_key")) continue;
      throw cause;
    }
  }
  throw new Error("Could not allocate a connect code.");
}

/**
 * Whether an account already uses this email. Drives the email-first flow: a
 * known email means "log in", an unknown one means "sign up". This deliberately
 * discloses existence — that branch is the whole point of the flow — unlike the
 * login endpoint, which hides it.
 */
export async function emailExists(email: string): Promise<boolean> {
  const row = await queryOne<{ x: number }>(
    `SELECT 1 AS x FROM users WHERE email = $1 AND deleted_at IS NULL`,
    [email.trim()],
  );
  return row !== null;
}

/** Resolves a pasted connect code to the account that owns it. */
export async function findByConnectCode(code: string): Promise<CurrentUser | null> {
  const row = await queryOne<UserRow>(
    `SELECT id, handle, email, display_name, avatar_url
       FROM users WHERE connect_code = $1 AND deleted_at IS NULL`,
    [code.trim().toUpperCase()],
  );
  return row ? toUser(row) : null;
}

/** Bulk lookup for the dashboard, which resolves ids that came from Redis. */
export async function usersByIds(ids: string[]): Promise<CurrentUser[]> {
  if (ids.length === 0) return [];
  const rows = await query<UserRow>(
    `SELECT id, handle, email, display_name, avatar_url
       FROM users WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
    [ids],
  );
  return rows.map(toUser);
}
