import { ingestApprovedExchanges } from "../../../../lib/ai/shared-memory";
import { events } from "../../../../lib/events";
import { ensureRepoIndexed } from "../../../../lib/knowledge/repo-context";
import { access, canWrite, denied, forbidden } from "../../../../lib/session/auth";
import { ensureWork, publishRoom, withRepoLock } from "../../../../lib/session/repo";
import { setHeadSha } from "../../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type PublishResponse =
  | { ok: true; sha: string }
  | { ok: false; reason: "conflict"; files: string[] };

/**
 * Publish a room's work back to its project's canonical `main` — the "merge to
 * the source of truth" step of the Git/Branch model.
 *
 * Needs write access (it changes the shared main), and only applies to a room
 * that belongs to a project. Conflicts are reported, not forced.
 */
export async function POST(_request: Request, context: RouteContext<"/api/sessions/[id]/publish">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (!canWrite(result.role)) {
    return forbidden("Publishing changes the project's shared main, which needs edit access.");
  }
  if (!result.session.projectId || !result.session.repo) {
    return Response.json(
      { error: "This room isn't part of a project, so there's nothing to publish to." },
      { status: 400 },
    );
  }

  // The working copy may have been reclaimed by retention; restore it first.
  await withRepoLock(id, () => ensureWork(id, result.session.repo!.headSha));

  const outcome = await publishRoom(id, result.session.projectId);
  if (!outcome.ok) {
    return Response.json(outcome satisfies PublishResponse, { status: 409 });
  }

  await setHeadSha(id, outcome.sha);

  // Publishing is the approval event for the knowledge layer: the room's
  // staged agent exchanges become shared memory now, and the freshly advanced
  // `main` is re-indexed for repo context. Both are best-effort background
  // work — neither delays nor fails the publish response.
  void ingestApprovedExchanges(id);
  void ensureRepoIndexed(result.session.projectId);

  await (await events()).publish(id, {
    type: "file.saved",
    path: "",
    headSha: outcome.sha,
    authorId: result.user.id,
    authorName: `${result.user.displayName} · published`,
    originId: null,
    at: Date.now(),
  });

  return Response.json(outcome satisfies PublishResponse);
}
