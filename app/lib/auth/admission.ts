import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { queryOne } from "../db/client";

export function signupMode(): "open" | "invite" | "closed" {
  const mode = process.env.SIGNUP_MODE || (process.env.NODE_ENV === "production" ? "invite" : "open");
  if (mode !== "open" && mode !== "invite" && mode !== "closed") throw new Error("Invalid SIGNUP_MODE.");
  return mode;
}
export class SignupAdmissionError extends Error {
  constructor() { super("New accounts require a valid invitation for this email. Ask your team administrator for an invitation link."); }
}
const digest = (token: string) => createHash("sha256").update(token).digest();

/** Do not treat an email allowlist as proof of identity: require the private link. */
export async function signupInvitation(email: string, token: unknown, tx?: PoolClient) {
  const mode = signupMode();
  if (mode === "open") return null;
  if (mode === "closed" || typeof token !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(token)) throw new SignupAdmissionError();
  const lookup = async (sql: string) => tx ? (await tx.query(sql, [digest(token), email.trim()])).rows[0] : queryOne<{ id: string }>(sql, [digest(token), email.trim()]);
  const beta = await lookup(`SELECT id FROM signup_invitations WHERE token_hash=$1 AND email=$2
    AND used_at IS NULL AND revoked_at IS NULL AND expires_at>now()${tx ? " FOR UPDATE" : ""}`);
  if (beta) return { kind: "beta" as const, id: beta.id as string };
  const org = await lookup(`SELECT i.id FROM org_invitations i JOIN orgs o ON o.id=i.org_id
    JOIN org_members m ON m.org_id=i.org_id AND m.user_id=i.invited_by
    JOIN users u ON u.id=i.invited_by
    WHERE i.token_hash=$1 AND i.email=$2 AND i.via='email' AND i.accepted_at IS NULL
      AND i.revoked_at IS NULL AND i.signup_user_id IS NULL AND i.expires_at>now()
      AND o.deleted_at IS NULL AND u.deleted_at IS NULL AND m.status='active' AND m.role IN ('owner','admin')${tx ? " FOR UPDATE OF i" : ""}`);
  if (org) return { kind: "org" as const, id: org.id as string };
  throw new SignupAdmissionError();
}
export async function issueSignupInvitation(email: string, hours = 72) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error("Provide a valid email and an expiry from 1 to 720 hours.");
  const token = randomBytes(32).toString("base64url");
  await queryOne(`INSERT INTO signup_invitations(email,token_hash,expires_at) VALUES ($1,$2,now()+$3::int*interval '1 hour') RETURNING id`, [email.trim(), digest(token), hours]);
  return token;
}
