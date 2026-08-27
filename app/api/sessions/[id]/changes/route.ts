import { access, denied } from "../../../../lib/session/auth";
import { ensureWork, listChangedFiles, withRepoLock } from "../../../../lib/session/repo";
import type { ChangesResponse } from "../../../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The files that differ between the session's seed commit and HEAD — the
 * "Changes" view of the explorer. The working copy is a cache, so it is rebuilt
 * to HEAD before the diff, exactly like the tree route.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;

  const repo = result.session.repo;
  if (!repo) {
    return Response.json(
      { error: "This session has no repository yet." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const changes = await withRepoLock(id, async () => {
    await ensureWork(id, repo.headSha);
    return listChangedFiles(id, repo.baseShaAtFork);
  });

  return Response.json({ changes } satisfies ChangesResponse, {
    headers: { "cache-control": "no-store" },
  });
}
