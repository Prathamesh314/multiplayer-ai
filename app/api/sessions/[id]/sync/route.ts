import { events } from "../../../../lib/events";
import { access, canWrite, denied, forbidden } from "../../../../lib/session/auth";
import { ensureWork, syncRoom, withRepoLock } from "../../../../lib/session/repo";
import { setHeadSha } from "../../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type SyncResponse =
  | { ok: true; sha: string }
  | { ok: false; reason: "conflict"; files: string[] };

/**
 * Pull the project's latest `main` into a room — pick up what other rooms have
 * published without leaving the room. The reverse of publish.
 */
export async function POST(_request: Request, context: RouteContext<"/api/sessions/[id]/sync">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (!canWrite(result.role)) {
    return forbidden("Syncing rewrites the room's files, which needs edit access.");
  }
  if (!result.session.projectId || !result.session.repo) {
    return Response.json(
      { error: "This room isn't part of a project, so there's nothing to sync from." },
      { status: 400 },
    );
  }

  await withRepoLock(id, () => ensureWork(id, result.session.repo!.headSha));

  const outcome = await syncRoom(id, result.session.projectId);
  if (!outcome.ok) {
    return Response.json(outcome satisfies SyncResponse, { status: 409 });
  }

  await setHeadSha(id, outcome.sha);
  await (await events()).publish(id, {
    type: "file.saved",
    path: "",
    headSha: outcome.sha,
    authorId: result.user.id,
    authorName: `${result.user.displayName} · synced`,
    originId: null,
    at: Date.now(),
  });

  return Response.json(outcome satisfies SyncResponse);
}
