import { publishRoleChanged } from "../../../../../../../lib/events";
import { forbidden, orgDenied, projectAccess } from "../../../../../../../lib/org/auth";
import {
  removeProjectMember,
  setProjectMemberRole,
  visibleRoomIds,
} from "../../../../../../../lib/project/store";
import { canManageProject } from "../../../../../../../lib/project/types";
import type { ProjectRole, UpdateProjectMemberRequest } from "../../../../../../../lib/project/types";
import { ensureMemberRoom } from "../../../../../../../lib/session/memberRoom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES: ProjectRole[] = ["manager", "editor", "viewer"];

/** Change an existing member's role. Project admins only. */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/members/[userId]">,
) {
  const { slug, projectSlug, userId } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  if (!canManageProject(result.role)) {
    return forbidden("Only a project admin can change roles.");
  }

  let body: UpdateProjectMemberRequest;
  try {
    body = (await request.json()) as UpdateProjectMemberRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!ROLES.includes(body.role)) {
    return Response.json({ error: "Pick a valid role." }, { status: 400 });
  }

  // Capture the rooms they can currently see *before* the change, then notify
  // after it commits so each room's client re-derives the new role.
  const rooms = await visibleRoomIds(result.project.id, userId);
  const updated = await setProjectMemberRole(result.project.id, userId, body.role);
  if (!updated) return Response.json({ error: "That person is not on this project." }, { status: 404 });

  // A promotion out of viewer earns them their member room on the spot.
  await ensureMemberRoom(result.project, userId, body.role).catch(() => null);

  await publishRoleChanged(rooms, userId);
  return Response.json({ updated: true });
}

/** Remove someone from the project, revoking their access to all its rooms. */
export async function DELETE(
  _request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/members/[userId]">,
) {
  const { slug, projectSlug, userId } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  if (!canManageProject(result.role)) {
    return forbidden("Only a project admin can remove members.");
  }

  const rooms = await visibleRoomIds(result.project.id, userId);
  await removeProjectMember(result.project.id, userId);
  await publishRoleChanged(rooms, userId);
  return Response.json({ removed: true });
}
