import { withApiLimit } from "../../../../lib/http/api-limit";
import { access, denied } from "../../../../lib/session/auth";
import { roomChangeDiff, roomChanges } from "../../../../lib/session/changes";
import { repositoryContext } from "../../../../lib/session/repository-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The room's changes since import, live while an agent works; `?path=` is one file's diff. */
async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const repo = await repositoryContext(result.session, request, result.user.id);
  if (repo instanceof Response) return repo;
  if (!repo.baseSha) return Response.json({ error: "This older import has no recorded baseline. Its files are available, but Changes cannot be calculated." }, { status: 409 });
  const target = { ref: repo.ref, baseSha: repo.baseSha, headSha: repo.headSha };
  const headers = { "cache-control": "no-store" };

  const path = new URL(request.url).searchParams.get("path");
  if (path !== null) {
    if (!path || path.length > 4096 || path.includes("\0")) return Response.json({ error: "Choose a file." }, { status: 400 });
    return Response.json({ diff: await roomChangeDiff(result.session.id, target, result.user.id, path) }, { headers });
  }
  return Response.json(await roomChanges(result.session.id, target, result.user.id), { headers });
}

export const GET = withApiLimit("/api/sessions/[id]/changes", handleGET);
