import { publishRoleChanged } from "../../../../../lib/events";
import { forbidden, orgAccess, orgDenied } from "../../../../../lib/org/auth";
import { getOrgMembership, removeOrgMember, updateOrgMember } from "../../../../../lib/org/store";
import { canManageOrg, type OrgRole, type UpdateOrgMemberRequest } from "../../../../../lib/org/types";
import { visibleRoomIdsInOrg } from "../../../../../lib/project/store";
import { isUuid } from "../../../../../lib/ai/turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES: OrgRole[] = ["owner", "admin", "member"];
const STATUSES = ["active", "suspended"] as const;

/**
 * Shared guard for both handlers: only an org admin may manage the roster, and
 * within that a few rules keep the hierarchy sane —
 *  - you can't act on your own membership here (leaving is a separate concern,
 *    and this stops an admin demoting or locking out themselves by accident),
 *  - only an owner may act on another owner, and only an owner may grant the
 *    owner role — admins manage members and admins, not owners.
 * The database's keep-an-owner trigger is the final backstop for the last owner.
 */
async function guard(
  slug: string,
  userId: string,
  nextRole?: OrgRole,
): Promise<{ orgId: string; actorId: string } | Response> {
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;
  if (!isUuid(userId)) return Response.json({ error: "Invalid member." }, { status: 400 });

  if (!canManageOrg(result.role)) return forbidden("Only an org admin can manage members.");
  if (userId === result.user.id) return forbidden("You can't change your own membership here.");

  const target = await getOrgMembership(result.org.id, userId);
  if (!target) return forbidden("That person is not in this organisation.");

  const callerIsOwner = result.role === "owner";
  if (target.role === "owner" && !callerIsOwner) {
    return forbidden("Only an owner can manage another owner.");
  }
  if (nextRole === "owner" && !callerIsOwner) {
    return forbidden("Only an owner can grant the owner role.");
  }

  return { orgId: result.org.id, actorId: result.user.id };
}

/** Change a member's role and/or active (suspended) status. Org admins only. */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/orgs/[slug]/members/[userId]">,
) {
  const { slug, userId } = await context.params;

  let body: UpdateOrgMemberRequest;
  try {
    body = (await request.json()) as UpdateOrgMemberRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!body || typeof body !== "object") return Response.json({ error: "Expected a JSON object." }, { status: 400 });
  if (body.role !== undefined && !ROLES.includes(body.role)) {
    return Response.json({ error: "Pick a valid role." }, { status: 400 });
  }
  if (body.status !== undefined && !STATUSES.includes(body.status)) {
    return Response.json({ error: "Pick a valid status." }, { status: 400 });
  }
  if (body.role === undefined && body.status === undefined) {
    return Response.json({ error: "Nothing to change." }, { status: 400 });
  }

  const gate = await guard(slug, userId, body.role);
  if (gate instanceof Response) return gate;

  // Org role/status changes ripple through implicit project-manager access, so
  // notify every room in the org this person can see. Capture before mutating.
  const rooms = await visibleRoomIdsInOrg(gate.orgId, userId);
  const outcome = await updateOrgMember(gate.orgId, userId, {
    role: body.role,
    status: body.status,
  }, gate.actorId);
  if (!outcome.ok) return forbidden(outcome.error);
  if (!outcome.updated) {
    return Response.json({ error: "That person is not in this organisation." }, { status: 404 });
  }

  await publishRoleChanged(rooms, userId);
  return Response.json({ updated: true });
}

/** Remove someone from the org, revoking their access to its projects and rooms. */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/orgs/[slug]/members/[userId]">,
) {
  const { slug, userId } = await context.params;

  const gate = await guard(slug, userId);
  if (gate instanceof Response) return gate;

  const rooms = await visibleRoomIdsInOrg(gate.orgId, userId);
  const outcome = await removeOrgMember(gate.orgId, userId, gate.actorId);
  if (!outcome.ok) return forbidden(outcome.error);

  await publishRoleChanged(rooms, userId);
  return Response.json({ removed: true });
}
