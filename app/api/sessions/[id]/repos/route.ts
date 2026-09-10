import { access, canWrite, denied, forbidden } from "../../../../lib/session/auth";
import { createRepo } from "../../../../lib/session/repo";
import { createRoomRepo, listRoomRepos } from "../../../../lib/session/roomRepos";
import type { RoomRepo } from "../../../../lib/session/roomRepos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type RoomReposResponse = { repos: RoomRepo[] };
export type CreateRoomRepoRequest = { name: string };
export type CreateRoomRepoResponse = { repo: RoomRepo };

/** The room's imported repos — the options a chat can target besides the fork. */
export async function GET(_request: Request, context: RouteContext<"/api/sessions/[id]/repos">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  return Response.json({ repos: await listRoomRepos(id) } satisfies RoomReposResponse);
}

/**
 * Start importing a repo into the room: allocate its record and its bare/work
 * pair on disk. The folder itself arrives next through the per-repo seed
 * route; until that finishes (`seededAt`), the repo takes no runs.
 *
 * Write access, not owner-only: an editor co-working in someone's room may
 * bring the codebase the collaboration needs — the record keeps who did.
 */
export async function POST(request: Request, context: RouteContext<"/api/sessions/[id]/repos">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (!canWrite(result.role)) {
    return forbidden("Importing a repo changes the room, which needs edit access.");
  }

  let body: CreateRoomRepoRequest;
  try {
    body = (await request.json()) as CreateRoomRepoRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 100) {
    return Response.json({ error: "Give the repo a name (at most 100 characters)." }, { status: 400 });
  }

  let repo: RoomRepo;
  try {
    repo = await createRoomRepo({ sessionId: id, rootName: name, createdBy: result.user.id });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "name") {
      return Response.json(
        { error: "This room already has a repo with that name." },
        { status: 409 },
      );
    }
    throw cause;
  }

  await createRepo(repo.id);
  return Response.json({ repo } satisfies CreateRoomRepoResponse);
}
