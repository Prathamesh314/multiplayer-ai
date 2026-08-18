import { access, denied } from "../../../../lib/session/auth";
import {
  checkoutHead,
  ensureWork,
  headSha,
  listTree,
  withRepoLock,
} from "../../../../lib/session/repo";
import { setHeadSha, touchSession } from "../../../../lib/session/store";
import type { TreeResponse } from "../../../../lib/session/types";
import type { TreeNode } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The tree at the session's recorded HEAD. This is the resume path: the working
 * copy is a cache, so it is realigned to the recorded sha before being read.
 */
export async function GET(_request: Request, context: RouteContext<"/api/sessions/[id]/tree">) {
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

  await touchSession(id, result.user.id);

  const root = await withRepoLock(id, async () => {
    // Rebuilds the working copy if it is gone, then realigns it only when it
    // has drifted, since a checkout is not free.
    await ensureWork(id, repo.headSha);

    const onDisk = await headSha(id).catch(() => null);
    if (onDisk !== repo.headSha) {
      try {
        await checkoutHead(id, repo.headSha);
      } catch {
        // The recorded sha is unreachable — trust the working copy and record
        // it rather than serving a tree that contradicts the stored state.
        if (onDisk) await setHeadSha(id, onDisk);
      }
    }

    return listTree(id, repo.rootName);
  });

  const totals = totalsOf(root);

  return Response.json(
    {
      rootName: repo.rootName,
      root,
      headSha: repo.headSha,
      sessionBranch: repo.sessionBranch,
      ...totals,
    } satisfies TreeResponse,
    { headers: { "cache-control": "no-store" } },
  );
}

function totalsOf(root: TreeNode): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;

  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "file") {
      files += 1;
      bytes += node.size ?? 0;
      continue;
    }
    for (const child of node.children ?? []) stack.push(child);
  }

  return { files, bytes };
}
