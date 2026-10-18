import { withApiLimit } from "../../../../lib/http/api-limit";
import { events } from "../../../../lib/events";
import { projectRepositoryForRoom } from "../../../../lib/project/repositories";
import { projectRoleOf } from "../../../../lib/project/store";
import { access, canWrite, denied, forbidden } from "../../../../lib/session/auth";
import { syncRoom } from "../../../../lib/session/repo";
import { repositoryContext } from "../../../../lib/session/repository-context";
import { setRoomRepoHeadSha } from "../../../../lib/session/roomRepos";
import { setHeadSha } from "../../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export type SyncResponse = { ok: true; sha: string } | { ok: false; reason: "conflict"; files: string[] };

async function handlePOST(request: Request, context: RouteContext<"/api/sessions/[id]/sync">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!canWrite(result.role)) return forbidden("Syncing needs edit access to this room.");
  if (!result.session.projectId || !await projectRoleOf(result.session.projectId, result.user.id)) return forbidden("Syncing needs project membership.");
  const repo = await repositoryContext(result.session, request, result.user.id);
  if (repo instanceof Response) return repo;
  const repositoryId = await projectRepositoryForRoom(id, repo.repoId);
  if (!repositoryId) return Response.json({ error: "Share this repository with the project before syncing." }, { status: 400 });
  const outcome = await syncRoom(repo.ref, repositoryId);
  if (!outcome.ok) return Response.json(outcome satisfies SyncResponse, { status: 409 });
  if (repo.repoId) await setRoomRepoHeadSha(repo.repoId, outcome.sha);
  else await setHeadSha(id, outcome.sha);
  await (await events()).publish(id, { type: "file.saved", repoId: repo.repoId, path: "", headSha: outcome.sha,
    authorId: result.user.id, authorName: `${result.user.displayName} · synced`, originId: null, at: Date.now() });
  return Response.json(outcome satisfies SyncResponse);
}

export const POST = withApiLimit("/api/sessions/[id]/sync", handlePOST);
