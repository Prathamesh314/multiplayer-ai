import { events } from "../../../../lib/events";
import { access, canWrite, denied, forbidden } from "../../../../lib/session/auth";
import { safeRelativePath } from "../../../../lib/session/paths";
import { repositoryContext } from "../../../../lib/session/repository-context";
import { mergeSave, readCommittedBytes } from "../../../../lib/session/repo";
import { setRoomRepoHeadSha } from "../../../../lib/session/roomRepos";
import { setHeadSha } from "../../../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const repo = await repositoryContext(result.session, request);
  if (repo instanceof Response) return repo;
  const url = new URL(request.url);
  const path = safeRelativePath(url.searchParams.get("path"));
  if (!path) return Response.json({ error: "Invalid file path." }, { status: 400 });
  try {
    const bytes = await readCommittedBytes(repo.ref, repo.headSha, path);
    if (!bytes) return Response.json({ error: "File not found, or symbolic links cannot be opened." }, { status: 404 });
    if (url.searchParams.get("raw") === "1") return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
    });
    const binary = bytes.subarray(0, 4096).includes(0);
    const limit = 2 * 1024 * 1024;
    return Response.json({ path, text: binary ? "" : bytes.subarray(0, limit).toString("utf8"),
      binary, size: bytes.length, truncated: bytes.length > limit }, { headers: { "cache-control": "no-store" } });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : "Could not read this file." }, { status: 422 });
  }
}

export async function PUT(request: Request, context: Context) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  if (!canWrite(result.role)) return forbidden("Edit access is required.");
  const repo = await repositoryContext(result.session, request);
  if (repo instanceof Response) return repo;
  const body = await request.json().catch(() => null);
  const path = safeRelativePath(body?.path);
  if (!path || typeof body?.text !== "string" || (body.baseText != null && typeof body.baseText !== "string")) {
    return Response.json({ error: "A valid path, text, and original text are required." }, { status: 400 });
  }
  if (body.text.length > 2 * 1024 * 1024 || (body.baseText?.length ?? 0) > 2 * 1024 * 1024) {
    return Response.json({ error: "This edit exceeds the 2 MB limit." }, { status: 413 });
  }
  try {
    const outcome = await mergeSave(repo.ref, path, body.baseText ?? "", body.text, repo.headSha,
      { name: result.user.displayName, email: result.user.email },
      sha => repo.repoId ? setRoomRepoHeadSha(repo.repoId, sha) : setHeadSha(id, sha));
    if (outcome.status === "conflict") return Response.json({ headSha: outcome.headSha, committed: false, conflict: true }, { status: 409 });
    if (outcome.status === "clean") await events().then(bus => bus.publish(id, {
      type: "file.saved", repoId: repo.repoId, path, headSha: outcome.headSha,
      authorId: result.user.id, authorName: result.user.displayName,
      originId: typeof body.originId === "string" ? body.originId : null, at: Date.now(),
    })).catch(() => {});
    return Response.json({ headSha: outcome.headSha, committed: outcome.status === "clean" });
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : "Could not save this file." }, { status: 422 });
  }
}
