import { createHash } from "node:crypto";
import { query, queryOne } from "../db/client";
import { ClerkAccountError } from "./clerk-config";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const proof = /^[A-Za-z0-9_-]{43}$/;
const invalid = () => new ClerkAccountError("This desktop sign-in expired or was already used. Start again in the desktop app.", 400);
export async function createDesktopSignIn(challenge: unknown) {
  if (typeof challenge !== "string" || !proof.test(challenge)) throw invalid();
  await query("DELETE FROM clerk_desktop_signins WHERE expires_at<now()");
  const row = await queryOne<{ id: string }>("INSERT INTO clerk_desktop_signins(challenge) VALUES($1) RETURNING id", [challenge]);
  return { id: row!.id, code: row!.id.slice(0, 8).toUpperCase() };
}
export async function approveDesktopSignIn(id: unknown, userId: string, sessionId: string) {
  if (typeof id !== "string" || !uuid.test(id)) throw invalid();
  const row = await queryOne(`UPDATE clerk_desktop_signins SET clerk_user_id=$2, approved_session_id=$3, approved_at=now()
    WHERE id=$1 AND expires_at>now() AND consumed_at IS NULL AND approved_at IS NULL RETURNING id`, [id, userId, sessionId]);
  if (!row) throw invalid();
}
export async function consumeDesktopSignIn(id: unknown, verifier: unknown) {
  if (typeof id !== "string" || !uuid.test(id) || typeof verifier !== "string" || !proof.test(verifier)) throw invalid();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const row = await queryOne<{ clerk_user_id: string; approved_session_id: string }>(`UPDATE clerk_desktop_signins SET consumed_at=now()
    WHERE id=$1 AND challenge=$2 AND expires_at>now() AND consumed_at IS NULL AND approved_at IS NOT NULL
    RETURNING clerk_user_id,approved_session_id`, [id, challenge]);
  if (!row) throw new ClerkAccountError("Complete and approve sign-in in your browser first. If this request has expired, start again.", 400);
  return row;
}
