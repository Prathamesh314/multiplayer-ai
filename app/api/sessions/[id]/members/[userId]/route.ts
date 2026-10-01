import { withApiLimit } from "../../../../../lib/http/api-limit";
import { publishRoleChanged } from "../../../../../lib/events";
import { access, denied, forbidden } from "../../../../../lib/session/auth";
import { removeMember } from "../../../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Remove someone from a room's roster. Owner-only, and the room's own owner
 * (its creator) can't be removed — a room with nobody who can manage it is not
 * a reachable state.
 */
async function handleDELETE(
  _request: Request,
  context: RouteContext<"/api/sessions/[id]/members/[userId]">,
) {
  const { id, userId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  // Same ownership check as adding: an editor still owns their own room even
  // when the project-derived role shadows their roster row.
  if (result.role !== "owner" && result.session.ownerId !== result.user.id) {
    return forbidden("Only the room owner can remove people from this room.");
  }
  if (userId === result.session.ownerId) {
    return forbidden("The room's creator can't be removed.");
  }

  await removeMember(id, userId);
  await publishRoleChanged([id], userId);
  return Response.json({ removed: true });
}

export const DELETE = withApiLimit("/api/sessions/[id]/members/[userId]", handleDELETE);
