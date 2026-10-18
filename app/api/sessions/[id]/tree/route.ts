import { withApiLimit } from "../../../../lib/http/api-limit";
import { access, denied } from "../../../../lib/session/auth";
import { repositoryContext } from "../../../../lib/session/repository-context";
import { listCommittedTree } from "../../../../lib/session/repo";
import type { TreeResponse } from "../../../../lib/session/types";
import type { TreeNode } from "../../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleGET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const result = await access(id);
  const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const repo = await repositoryContext(result.session, request, result.user.id);
  if (repo instanceof Response) return repo;
  const root = await listCommittedTree(repo.ref, repo.rootName, repo.headSha);
  return Response.json({ rootName: repo.rootName, root, headSha: repo.headSha,
    sessionBranch: repo.sessionBranch, ...totalsOf(root) } satisfies TreeResponse,
  { headers: { "cache-control": "no-store" } });
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

export const GET = withApiLimit("/api/sessions/[id]/tree", handleGET);
