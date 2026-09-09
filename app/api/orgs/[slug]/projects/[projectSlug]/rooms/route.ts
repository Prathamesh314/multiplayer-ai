import { orgDenied, projectAccess } from "../../../../../../lib/org/auth";
import { ensureMemberRoom } from "../../../../../../lib/session/memberRoom";
import { listRoomsInProject } from "../../../../../../lib/session/store";
import type { SessionListResponse } from "../../../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Rooms in a project. Rooms are not opened by hand any more: every member has
 * exactly one, so listing them provisions the caller's own room first. That
 * also covers members who predate the one-room rule and org admins whose
 * project access is implicit — the first look at the project creates theirs.
 */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/rooms">,
) {
  const { slug, projectSlug } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  // Best-effort: a seeding failure (git missing, disk trouble) should not make
  // the rest of the project's rooms unlistable.
  await ensureMemberRoom(result.project, result.user.id, result.role, result.user.handle).catch(
    () => null,
  );

  const sessions = await listRoomsInProject(result.project.id, result.user.id);
  return Response.json({ sessions } satisfies SessionListResponse, {
    headers: { "cache-control": "no-store" },
  });
}
