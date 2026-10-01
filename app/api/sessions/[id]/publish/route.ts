import { withApiLimit } from "../../../../lib/http/api-limit";
import { ingestApprovedExchanges } from "../../../../lib/ai/shared-memory";
import { events } from "../../../../lib/events";
import { ensureRepoContext } from "../../../../lib/knowledge/repo-context";
import { publishSelectedRepository } from "../../../../lib/project/repository-workspaces";
import { projectRoleOf } from "../../../../lib/project/store";
import { access, canWrite, denied, forbidden } from "../../../../lib/session/auth";
import { repositoryContext } from "../../../../lib/session/repository-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export type PublishResponse = { ok: true; sha: string; projectRepositoryId?: string } | { ok: false; reason: "conflict"; files: string[] };

/** Publish only the selected repository; first publication explicitly shares it. */
async function handlePOST(request: Request, context: RouteContext<"/api/sessions/[id]/publish">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const projectId = result.session.projectId;
  if (!canWrite(result.role)) return forbidden("Publishing needs edit access to this room.");
  if (!projectId) return Response.json({ error: "This room has no project to share with." }, { status: 400 });
  const role = await projectRoleOf(projectId, result.user.id);
  if (!role || role === "viewer") return forbidden("Publishing needs edit access to the project.");
  const repo = await repositoryContext(result.session, request);
  if (repo instanceof Response) return repo;
  let outcome;
  try {
    outcome = await publishSelectedRepository({ sessionId: id, repoId: repo.repoId, projectId, name: repo.rootName, createdBy: result.user.id, headSha: repo.headSha });
  } catch (cause) {
    if ((cause as { code?: string }).code === "23505") return Response.json({ error: "A project repository already uses that name. Select it from Project repositories, or import this folder under a different name before sharing." }, { status: 409 });
    throw cause;
  }
  if (!outcome.ok) return Response.json(outcome satisfies PublishResponse, { status: 409 });
  const repositoryId = outcome.projectRepositoryId;
  await ingestApprovedExchanges(id, outcome.sha, result.user.id, repo.ref).catch(cause => {
    console.warn("Published memory approval deferred to its durable job", cause instanceof Error ? cause.message : cause);
  });
  await Promise.all([ensureRepoContext(repositoryId, outcome.sha), ensureRepoContext(repo.ref, outcome.sha)]);
  await (await events()).publish(id, { type: "file.saved", repoId: repo.repoId, path: "", headSha: outcome.sha,
    authorId: result.user.id, authorName: `${result.user.displayName} · published`, originId: null, at: Date.now() });
  return Response.json({ ...outcome, projectRepositoryId: repositoryId } satisfies PublishResponse);
}

export const POST = withApiLimit("/api/sessions/[id]/publish", handlePOST);
