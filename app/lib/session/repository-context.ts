import type { Session } from "./types";
import { getRoomRepo } from "./roomRepos";
import { isSessionId } from "./paths";

export type RepositoryContext = {
  ref: string;
  repoId: string | null;
  rootName: string;
  headSha: string;
  baseSha: string | null;
  sessionBranch: string;
};

export async function repositoryContext(session: Session, request: Request): Promise<RepositoryContext | Response> {
  const repoId = new URL(request.url).searchParams.get("repoId");
  if (repoId) {
    const repo = isSessionId(repoId) ? await getRoomRepo(repoId) : null;
    if (!repo || repo.sessionId !== session.id) return Response.json({ error: "Repository not found in this room." }, { status: 404 });
    if (!repo.seededAt || !repo.headSha) return Response.json({ error: "This repository is still importing. Retry the upload to finish." }, { status: 409 });
    return { ref: repo.id, repoId: repo.id, rootName: repo.rootName, headSha: repo.headSha, baseSha: repo.baseSha, sessionBranch: `session/${repo.id}` };
  }
  if (!session.repo) return Response.json({ error: "This room has no repository yet." }, { status: 404 });
  return { ref: session.id, repoId: null, rootName: session.repo.rootName, headSha: session.repo.headSha, baseSha: session.repo.baseShaAtFork, sessionBranch: session.repo.sessionBranch };
}
