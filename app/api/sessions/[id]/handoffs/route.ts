import { access, canWrite, denied } from "../../../../lib/session/auth";
import { query } from "../../../../lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!canWrite(result.role)) return Response.json({ offers: [] });
  const offers = await query(
    `SELECT h.id, h.run_id AS "runId", r.title, u.display_name AS sender, h.note
     FROM run_handoffs h JOIN agent_runs r ON r.id = h.run_id
     JOIN users u ON u.id = h.from_user_id
     WHERE r.session_id = $1 AND h.status = 'pending' AND h.expires_at > now()
       AND h.from_user_id <> $2 AND (h.to_user_id IS NULL OR h.to_user_id = $2)
       AND h.control_version = r.control_version ORDER BY h.created_at DESC`, [id, result.user.id],
  );
  return Response.json({ offers }, { headers: { "cache-control": "no-store" } });
}
