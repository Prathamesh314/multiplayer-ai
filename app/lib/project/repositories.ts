import { randomUUID } from "node:crypto";
import { query, queryOne, transaction } from "../db/client";

export type ProjectRepository = {
  id: string;
  projectId: string;
  name: string;
  upstreamUrl: string | null;
  githubRepo: string | null;
  defaultBranch: string;
  ready: boolean;
};

const columns = `id, project_id AS "projectId", name, upstream_url AS "upstreamUrl",
  ready, github_repo AS "githubRepo", default_branch AS "defaultBranch"`;

export async function listProjectRepositories(projectId: string): Promise<ProjectRepository[]> {
  return query<ProjectRepository>(`SELECT ${columns} FROM project_repositories WHERE project_id = $1 AND ready ORDER BY created_at, id`, [projectId]);
}

export async function getProjectRepository(id: string): Promise<ProjectRepository | null> {
  return queryOne<ProjectRepository>(`SELECT ${columns} FROM project_repositories WHERE id = $1`, [id]);
}

/** Explicit membership, never inferred from a project's id. */
export async function projectRepositoryForRoom(sessionId: string, repoId: string | null): Promise<string | null> {
  const row = repoId
    ? await queryOne<{ id: string | null }>(`SELECT project_repository_id AS id FROM room_repos WHERE session_id = $1 AND id = $2`, [sessionId, repoId])
    : await queryOne<{ id: string | null }>(`SELECT project_repository_id AS id FROM session_repos WHERE session_id = $1`, [sessionId]);
  return row?.id ?? null;
}

/** Called under the source repository lock. An import remains room-only until shared. */
export async function registerRoomRepository(input: {
  sessionId: string; repoId: string | null; projectId: string; name: string; createdBy: string;
}): Promise<string> {
  const existing = await projectRepositoryForRoom(input.sessionId, input.repoId);
  if (existing) return existing;
  return transaction(async tx => {
    const id = randomUUID();
    await tx.query(`INSERT INTO project_repositories (id, project_id, name, upstream_url, created_by)
      SELECT $1, $2, $3, upstream_url, $4 FROM ${input.repoId ? "room_repos WHERE id = $5" : "session_repos WHERE session_id = $5"}`,
      [id, input.projectId, input.name, input.createdBy, input.repoId ?? input.sessionId]);
    await tx.query(`UPDATE ${input.repoId ? "room_repos" : "session_repos"} SET project_repository_id = $2 WHERE ${input.repoId ? "id" : "session_id"} = $1`, [input.repoId ?? input.sessionId, id]);
    return id;
  });
}
