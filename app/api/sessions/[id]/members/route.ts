import { presence } from "../../../../lib/presence";
import { access, denied } from "../../../../lib/session/auth";
import { membersOf } from "../../../../lib/session/store";
import type { MembersResponse } from "../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The roster, with live presence folded in.
 *
 * Two stores, joined here rather than in SQL: Postgres is the authority on who
 * *may* be here, Redis on who *is*. The intersection is deliberate — a member
 * whose access was just revoked can still be mid-heartbeat.
 */
export async function GET(_request: Request, context: RouteContext<"/api/sessions/[id]/members">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  const roster = await membersOf(id);
  const online = new Set(await (await presence()).onlineInSession(id));

  const members = roster.map((member) => ({
    ...member,
    online: online.has(member.userId),
    isSelf: member.userId === result.user.id,
  }));

  return Response.json({ members } satisfies MembersResponse, {
    headers: { "cache-control": "no-store" },
  });
}
