import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { orgDenied, projectAccess } from "../../../../../../lib/org/auth";
import { ensureMemberRoom } from "../../../../../../lib/session/memberRoom";
import { listRoomsInProject } from "../../../../../../lib/session/store";
import { memberRoleOf } from "../../../../../../lib/project/store";
import type { SessionListResponse } from "../../../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rooms in a project. Rooms are not opened by hand any more: every member has
 * exactly one, so listing them provisions the caller's own room first (for
 * members who predate the one-room rule). Only added members get one:
 * organisation owners and admins can look at every project, and looking must
 * not make them appear as a member of each.
 */
async function handleGET(
  _request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/rooms">,
) {
  const { slug, projectSlug } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  // Best-effort: a seeding failure (git missing, disk trouble) should not make
  // the rest of the project's rooms unlistable.
  const memberRole = await memberRoleOf(result.project.id, result.user.id);
  if (memberRole) await ensureMemberRoom(result.project, result.user.id, memberRole, result.user.handle).catch(() => null);

  const sessions = await listRoomsInProject(result.project.id, result.user.id);
  return Response.json({ sessions } satisfies SessionListResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/orgs/[slug]/projects/[projectSlug]/rooms", handleGET);
