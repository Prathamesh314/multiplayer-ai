import { forbidden, orgDenied, projectAccess } from "../../../../../../lib/org/auth";
import { createRepo, gitAvailable } from "../../../../../../lib/session/repo";
import { createSession, listRoomsInProject } from "../../../../../../lib/session/store";
import { canEdit } from "../../../../../../lib/session/types";
import { projectRoleToSessionRole } from "../../../../../../lib/project/types";
import type { SessionListResponse } from "../../../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Rooms in a project. Every project member can open every one of them. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/rooms">,
) {
  const { slug, projectSlug } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  const sessions = await listRoomsInProject(result.project.id);
  return Response.json({ sessions } satisfies SessionListResponse, {
    headers: { "cache-control": "no-store" },
  });
}

/** Open a new room on the project's repo. Requires edit access to the project. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/orgs/[slug]/projects/[projectSlug]/rooms">,
) {
  const { slug, projectSlug } = await context.params;
  const result = await projectAccess(slug, projectSlug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  if (!canEdit(projectRoleToSessionRole(result.role))) {
    return forbidden("You need edit access to this project to open a room.");
  }

  if (!(await gitAvailable())) {
    return Response.json(
      { error: "git is not installed on the server, so rooms cannot be created." },
      { status: 503 },
    );
  }

  let body: { name?: string } = {};
  try {
    body = (await request.json()) as { name?: string };
  } catch {
    // An empty body is fine; the room gets a generated name.
  }

  const session = await createSession(result.user.id, body.name, {
    orgId: result.org.id,
    projectId: result.project.id,
  });

  // The repo is created up front so seeding (or a future GitHub clone) has
  // somewhere to land, and an unseeded room fails loudly rather than half-exists.
  await createRepo(session.id);

  return Response.json(session, { status: 201 });
}
