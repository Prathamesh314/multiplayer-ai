import { access, canWrite, denied, forbidden } from "../../../../lib/session/auth";
import { safeRelativePath } from "../../../../lib/session/paths";
import {
  commitWork,
  ensureWork,
  readRepoBytes,
  readRepoFile,
  withRepoLock,
  writeRepoFile,
} from "../../../../lib/session/repo";
import { setHeadSha, touchSession } from "../../../../lib/session/store";
import type {
  FileResponse,
  SaveFileRequest,
  SaveFileResponse,
} from "../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_REPO = { error: "This session has no repository yet." };
const BAD_PATH = { error: "That file path is not valid for this session." };

export async function GET(request: Request, context: RouteContext<"/api/sessions/[id]/file">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  const repo = result.session.repo;
  if (!repo) return Response.json(NO_REPO, { status: 404 });

  const url = new URL(request.url);
  const path = safeRelativePath(url.searchParams.get("path"));
  if (!path) return Response.json(BAD_PATH, { status: 400 });

  await withRepoLock(id, () => ensureWork(id, repo.headSha));

  // `raw=1` streams the bytes back, which is what reading a binary needs;
  // everything else wants the decoded, size-capped text.
  if (url.searchParams.get("raw") === "1") {
    const bytes = await readRepoBytes(id, path);
    if (!bytes) return Response.json({ error: "No such file." }, { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
    });
  }

  const file = await readRepoFile(id, path);
  if (!file) return Response.json({ error: "No such file." }, { status: 404 });

  return Response.json({ path, ...file } satisfies FileResponse, {
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Writes a file and commits it in the same request. The invariant the whole
 * design rests on is that a session never holds uncommitted state, so there is
 * deliberately no way to save without committing.
 */
export async function PUT(request: Request, context: RouteContext<"/api/sessions/[id]/file">) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  if (!canWrite(result.role)) {
    return forbidden(
      "You have read access to this session. Ask the owner for edit access to make changes.",
    );
  }

  const repo = result.session.repo;
  if (!repo) return Response.json(NO_REPO, { status: 404 });

  let body: SaveFileRequest;
  try {
    body = (await request.json()) as SaveFileRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const path = safeRelativePath(body.path);
  if (!path) return Response.json(BAD_PATH, { status: 400 });
  if (typeof body.text !== "string") {
    return Response.json({ error: "A file body is required." }, { status: 400 });
  }

  const previous = repo.headSha;
  await touchSession(id, result.user.id);

  const sha = await withRepoLock(id, async () => {
    await ensureWork(id, previous);
    if (!(await writeRepoFile(id, path, body.text))) return null;
    return commitWork(id, `WIP: ${path}`, result.user.displayName, result.user.email);
  });

  if (sha === null) {
    // Either the write was rejected or the contents were already identical.
    return Response.json({ headSha: previous, committed: false } satisfies SaveFileResponse);
  }

  await setHeadSha(id, sha);
  return Response.json({ headSha: sha, committed: true } satisfies SaveFileResponse);
}
