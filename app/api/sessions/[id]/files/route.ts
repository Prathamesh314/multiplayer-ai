import { withApiLimit } from "../../../../lib/http/api-limit";
import { events } from "../../../../lib/events";
import { ensureRepoContext } from "../../../../lib/knowledge/repo-context";
import { access, canWrite, denied, forbidden } from "../../../../lib/session/auth";
import { repositoryContext } from "../../../../lib/session/repository-context";
import { addFiles, MAX_ADD_FILES } from "../../../../lib/session/repo";
import { setRoomRepoHeadSha } from "../../../../lib/session/roomRepos";
import { setHeadSha } from "../../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** Under the Next proxy's 10 MB body buffer, which truncates silently. */
const MAX_ADD_REQUEST_BYTES = 9 * 1024 * 1024;

/**
 * Add files to the repository from the explorer (New file, New folder, Upload,
 * drag and drop). Multipart: `paths` is a JSON array of relative paths, then
 * one `file` part per path in the same order; `overwrite=1` confirms
 * replacing files that already exist. One commit for the whole request.
 */
async function handlePOST(request: Request, context: Context) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!canWrite(result.role)) return forbidden("Edit access is required.");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_ADD_REQUEST_BYTES) {
    return Response.json({ error: "Upload at most 9 MB at a time." }, { status: 413 });
  }
  const repo = await repositoryContext(result.session, request, result.user.id);
  if (repo instanceof Response) return repo;
  const form = await request.formData().catch(() => null);
  let paths: unknown = null;
  try { paths = JSON.parse(String(form?.get("paths") ?? "null")); } catch { /* invalid below */ }
  const parts = form?.getAll("file") ?? [];
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_ADD_FILES || paths.length !== parts.length
      || !paths.every((path) => typeof path === "string") || !parts.every((part) => part instanceof Blob)) {
    return Response.json({ error: `Send between 1 and ${MAX_ADD_FILES} files with their paths.` }, { status: 400 });
  }
  try {
    const files = await Promise.all((parts as Blob[]).map(async (part, index) => ({ path: paths[index] as string, bytes: Buffer.from(await part.arrayBuffer()) })));
    const outcome = await addFiles(repo.ref, files, form?.get("overwrite") === "1",
      { name: result.user.displayName, email: result.user.email },
      (sha) => repo.repoId ? setRoomRepoHeadSha(repo.repoId, sha) : setHeadSha(id, sha));
    if (outcome.status === "exists") {
      return Response.json({ error: "Some files already exist.", exists: outcome.paths }, { status: 409 });
    }
    const bus = await events().catch(() => null);
    for (const path of [...outcome.added, ...outcome.replaced]) {
      await bus?.publish(id, { type: "file.saved", repoId: repo.repoId, path, headSha: outcome.headSha,
        authorId: result.user.id, authorName: result.user.displayName, originId: null, at: Date.now() }).catch(() => {});
    }
    if (repo.repoId || !result.session.projectId) await ensureRepoContext(repo.ref, outcome.headSha);
    return Response.json({ headSha: outcome.headSha, added: outcome.added, replaced: outcome.replaced });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : "Could not add these files." }, { status: 422 });
  }
}

export const POST = withApiLimit("/api/sessions/[id]/files", handlePOST);
