import { presence } from "../../../../lib/presence";
import { projectRoleOf } from "../../../../lib/project/store";
import { access, denied, forbidden } from "../../../../lib/session/auth";
import { addMember, membersOf } from "../../../../lib/session/store";
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

/**
 * Add someone to this room's roster — the way people get into a private room.
 * Only a room owner (its creator, or a project manager on a public room) may do
 * it, and only project members can be added, so a private room can never leak
 * access to someone who isn't even on the project.
 */
export async function POST(request: Request, context: RouteContext<"/api/sessions/[id]/members">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (result.role !== "owner") {
    return forbidden("Only the room owner can add people to this room.");
  }

  let body: { userId?: string; role?: "editor" | "viewer" };
  try {
    body = (await request.json()) as { userId?: string; role?: "editor" | "viewer" };
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const userId = String(body.userId ?? "");
  if (!userId) return Response.json({ error: "Name who to add." }, { status: 400 });

  // The target must already have access to the room's project.
  if (result.session.projectId) {
    const projectRole = await projectRoleOf(result.session.projectId, userId);
    if (!projectRole) {
      return Response.json(
        { error: "That person is not on this project. Add them to the project first." },
        { status: 409 },
      );
    }
  }

  const role = body.role === "viewer" ? "viewer" : "editor";
  await addMember(id, userId, role, "owner", result.user.id);
  return Response.json({ added: true }, { status: 201 });
}
