import { access, denied } from "../../../../lib/session/auth";
import { repositoryContext } from "../../../../lib/session/repository-context";
import { committedChanges } from "../../../../lib/session/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const repo = await repositoryContext(result.session, request);
  if (repo instanceof Response) return repo;
  if (!repo.baseSha) return Response.json({ error: "This older import has no recorded baseline. Its files are available, but Changes cannot be calculated." }, { status: 409 });
  return Response.json({ changes: await committedChanges(repo.ref, repo.baseSha, repo.headSha) }, { headers: { "cache-control": "no-store" } });
}
