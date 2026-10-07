import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { query, queryOne, transaction } from "../db/client";
import { emailDeliveryConfig, emailVerificationEnabled, EmailVerificationError, sendVerificationEmail } from "./email-delivery";
import type { CurrentUser, EmailVerificationState } from "./types";

const tokenValid = (token: unknown): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
const digest = (token: string) => createHash("sha256").update(token).digest();
// The high-entropy secret lives only in the HttpOnly cookie, preventing offline
// enumeration of six-digit codes from a database dump.
const codeDigest = (token: string, code: string) => createHmac("sha256", token).update(code).digest();
const expired = () => new EmailVerificationError("This verification request has expired. Sign in again to request a new code.", 409, undefined, "verification_expired");
type User = { id: string; email: string; email_verified_at: Date | null; deleted_at: Date | null; handle: string; display_name: string; avatar_url: string | null };
type Challenge = {
  user_id: string; email: string; token_hash: Buffer; code_hash: Buffer; token_expires_at: Date; code_expires_at: Date;
  attempts: number; resend_after: Date; window_started_at: Date; send_count: number; delivery_id: string;
  delivery_status: "pending" | "sent" | "failed";
};
const retryAt = (row: Challenge) => Math.max(row.resend_after.getTime(), row.send_count >= 5 ? row.window_started_at.getTime() + 3600000 : 0);
const state = (row: Challenge): EmailVerificationState => ({ serverTime: Date.now(), email: row.email, codeExpiresAt: row.code_expires_at.getTime(), resendAt: retryAt(row), deliveryStatus: row.delivery_status, attemptsRemaining: Math.max(0, 5 - row.attempts) });
async function lockUser(tx: PoolClient, userId: string) {
  const user = (await tx.query<User>("SELECT * FROM users WHERE id=$1 FOR UPDATE", [userId])).rows[0];
  if (!user || user.deleted_at) throw expired();
  return user;
}
function assertEnabled() {
  if (!emailVerificationEnabled()) throw new EmailVerificationError("Sign in again to continue.", 409, undefined, "verification_expired");
}
function enforceSendBudget(row?: Challenge) {
  if (!row) return;
  const seconds = Math.ceil((retryAt(row) - Date.now()) / 1000);
  if (seconds > 0) throw new EmailVerificationError("Please wait before requesting another verification code.", 429, seconds, "resend_limited");
}
async function reserve(tx: PoolClient, user: User, token: string, previous?: Challenge, resend = false) {
  enforceSendBudget(previous);
  let code: string;
  do { code = randomInt(1000000).toString().padStart(6, "0"); }
  while (previous && timingSafeEqual(codeDigest(token, code), Buffer.from(previous.code_hash)));
  const row = (await tx.query<Challenge>(`INSERT INTO email_verifications
    (user_id,email,token_hash,code_hash,token_expires_at,code_expires_at,resend_after,send_count,delivery_id)
    VALUES ($1,$2,$3,$4,now()+interval '1 hour',now()+interval '10 minutes',now()+interval '1 minute',1,$5)
    ON CONFLICT (user_id) DO UPDATE SET email=EXCLUDED.email,token_hash=EXCLUDED.token_hash,code_hash=EXCLUDED.code_hash,
      token_expires_at=CASE WHEN $6 THEN email_verifications.token_expires_at ELSE EXCLUDED.token_expires_at END,
      code_expires_at=EXCLUDED.code_expires_at,resend_after=EXCLUDED.resend_after,attempts=0,
      window_started_at=CASE WHEN email_verifications.window_started_at<=now()-interval '1 hour' THEN now() ELSE email_verifications.window_started_at END,
      send_count=CASE WHEN email_verifications.window_started_at<=now()-interval '1 hour' THEN 1 ELSE email_verifications.send_count+1 END,
      delivery_id=EXCLUDED.delivery_id,delivery_status='pending' RETURNING *`,
  [user.id, user.email, digest(token), codeDigest(token, code), randomUUID(), resend])).rows[0];
  return { row, code, token };
}
async function deliver(reserved: Awaited<ReturnType<typeof reserve>>) {
  const { row, code, token } = reserved;
  let status: "sent" | "failed" = "sent";
  try { await sendVerificationEmail(row.email, code, row.delivery_id); } catch { status = "failed"; }
  // A slow or failed delivery can never confirm a newer challenge's code.
  const updated = await queryOne<Challenge>(`UPDATE email_verifications SET delivery_status=$3
    WHERE token_hash=$1 AND delivery_id=$2 AND token_expires_at>now() RETURNING *`, [row.token_hash, row.delivery_id, status]);
  if (!updated) throw expired();
  return { token, verification: state(updated) };
}

/** Call only after password authentication or successful account creation. */
export async function startEmailVerification(userId: string, previousToken?: string) {
  if (!emailVerificationEnabled()) return null;
  const result = await transaction(async tx => {
    const user = await lockUser(tx, userId);
    if (user.email_verified_at) return null;
    emailDeliveryConfig(); // Missing configuration never grants a session.
    const previous = (await tx.query<Challenge>("SELECT * FROM email_verifications WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
    if (previous && tokenValid(previousToken) && timingSafeEqual(Buffer.from(previous.token_hash), digest(previousToken)) &&
        previous.token_expires_at.getTime() > Date.now() && previous.email.toLowerCase() === user.email.toLowerCase()) {
      return { token: previousToken, verification: state(previous) };
    }
    return reserve(tx, user, randomBytes(32).toString("base64url"), previous);
  });
  return result && ("row" in result ? deliver(result) : result);
}

export async function pendingEmailVerification(token?: string): Promise<EmailVerificationState | null> {
  if (!tokenValid(token) || !emailVerificationEnabled()) return null;
  const row = await queryOne<Challenge>(`SELECT v.* FROM email_verifications v JOIN users u ON u.id=v.user_id
    WHERE v.token_hash=$1 AND v.token_expires_at>now() AND u.email=v.email AND u.email_verified_at IS NULL AND u.deleted_at IS NULL`, [digest(token)]);
  return row ? state(row) : null;
}

export async function resendEmailVerification(token?: string) {
  assertEnabled();
  if (!tokenValid(token)) throw expired();
  emailDeliveryConfig();
  const candidate = await queryOne<{ user_id: string }>("SELECT user_id FROM email_verifications WHERE token_hash=$1", [digest(token)]);
  if (!candidate) throw expired();
  const reserved = await transaction(async tx => {
    const user = await lockUser(tx, candidate.user_id);
    const previous = (await tx.query<Challenge>("SELECT * FROM email_verifications WHERE user_id=$1 AND token_hash=$2 FOR UPDATE", [user.id, digest(token)])).rows[0];
    if (!previous || previous.token_expires_at.getTime() <= Date.now() || user.email_verified_at || user.email.toLowerCase() !== previous.email.toLowerCase()) throw expired();
    return reserve(tx, user, token, previous, true);
  });
  return (await deliver(reserved)).verification;
}

export async function verifyEmailCode(token: string | undefined, code: unknown): Promise<CurrentUser> {
  assertEnabled();
  if (!tokenValid(token)) throw expired();
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw new EmailVerificationError("Enter the six-digit code from your email.", 400, undefined, "invalid_code");
  const candidate = await queryOne<{ user_id: string }>("SELECT user_id FROM email_verifications WHERE token_hash=$1", [digest(token)]);
  if (!candidate) throw expired();
  const result = await transaction(async tx => {
    const user = await lockUser(tx, candidate.user_id);
    const row = (await tx.query<Challenge>("SELECT * FROM email_verifications WHERE user_id=$1 AND token_hash=$2 FOR UPDATE", [user.id, digest(token)])).rows[0];
    if (!row || row.token_expires_at.getTime() <= Date.now() || user.email_verified_at || user.email.toLowerCase() !== row.email.toLowerCase()) throw expired();
    if (row.delivery_status !== "sent") throw new EmailVerificationError("Your code hasn’t been sent yet. Please request another code.", 400, undefined, "delivery_failed");
    if (row.code_expires_at.getTime() <= Date.now()) throw new EmailVerificationError("This code has expired. Request a new code.", 400, undefined, "code_expired");
    if (row.attempts >= 5) throw new EmailVerificationError("Too many incorrect codes. Request a new code.", 429, undefined, "attempts_exhausted");
    if (!timingSafeEqual(Buffer.from(row.code_hash), codeDigest(token, code))) {
      await tx.query("UPDATE email_verifications SET attempts=attempts+1 WHERE user_id=$1", [user.id]);
      return { error: row.attempts === 4 ? "Too many incorrect codes. Request a new code." : "That code is incorrect. Please try again.", status: row.attempts === 4 ? 429 : 400 };
    }
    await tx.query("UPDATE users SET email_verified_at=now() WHERE id=$1", [user.id]);
    await tx.query("DELETE FROM email_verifications WHERE user_id=$1", [user.id]);
    return { user: { id: user.id, email: user.email, handle: user.handle, displayName: user.display_name, avatarUrl: user.avatar_url } };
  });
  // Throw after committing so failed attempts cannot be rolled back.
  if (result.error) throw new EmailVerificationError(result.error, result.status, undefined, result.status === 429 ? "attempts_exhausted" : "incorrect_code");
  return result.user!;
}

export async function cancelEmailVerification(token?: string) {
  if (tokenValid(token)) await query("UPDATE email_verifications SET token_expires_at=now() WHERE token_hash=$1", [digest(token)]);
}
