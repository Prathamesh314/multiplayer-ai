import { access, denied, forbidden } from "../../../../../lib/session/auth";
import { removeMember } from "../../../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Remove someone from a room's roster. Owner-only, and the room's own owner
 * (its creator) can't be removed — a room with nobody who can manage it is not
 * a reachable state.
 */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/sessions/[id]/members/[userId]">,
) {
  const { id, userId } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (result.role !== "owner") {
    return forbidden("Only the room owner can remove people from this room.");
  }
  if (userId === result.session.ownerId) {
    return forbidden("The room's creator can't be removed.");
  }

  await removeMember(id, userId);
  return Response.json({ removed: true });
}
