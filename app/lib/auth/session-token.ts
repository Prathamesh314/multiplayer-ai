import { createHash } from "node:crypto";
import { queryOne } from "../db/client";
import type { CurrentUser } from "./types";

/** Check revocation on every request; only the approximate usage timestamp is throttled. */
export async function userFromSessionToken(token: string): Promise<CurrentUser | null> {
  const row = await queryOne<{
    id: string; handle: string; email: string; display_name: string; avatar_url: string | null;
  }>(`WITH valid AS MATERIALIZED (
      SELECT t.id AS token_id, t.last_used_at, u.id, u.handle, u.email, u.display_name, u.avatar_url
      FROM auth_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>now() AND u.deleted_at IS NULL
    ), touched AS (
      UPDATE auth_tokens t SET last_used_at=now() FROM valid v
      WHERE t.id=v.token_id AND t.revoked_at IS NULL
        AND (t.last_used_at IS NULL OR t.last_used_at<now()-interval '1 minute')
      RETURNING t.id
    ) SELECT id, handle, email, display_name, avatar_url FROM valid`,
  [createHash("sha256").update(token,"utf8").digest()]);
  return row ? { id:row.id, handle:row.handle, email:row.email, displayName:row.display_name, avatarUrl:row.avatar_url } : null;
}
