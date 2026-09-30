/** Independently selected repositories inside a room; no mandatory project fork. */

import { query, queryOne } from "../db/client";
import { mintPathId } from "./store";

export type RoomRepo = {
  id: string;
  sessionId: string;
  projectRepositoryId?: string | null;
  rootName: string;
  headSha: string | null;
  baseSha: string | null;
  upstreamUrl: string | null;
  createdBy: string;
  createdAt: number;
  /** Null until the upload committed; a repo without this must not take runs. */
  seededAt: number | null;
};

type RepoRow = {
  id: string;
  session_id: string;
  project_repository_id: string | null;
  root_name: string;
  head_sha: string | null;
  base_sha: string | null;
  upstream_url: string | null;
  created_by: string;
  created_at: Date;
  seeded_at: Date | null;
};

const toRepo = (row: RepoRow): RoomRepo => ({
  id: row.id,
  sessionId: row.session_id,
  projectRepositoryId: row.project_repository_id,
  rootName: row.root_name,
  headSha: row.head_sha,
  baseSha: row.base_sha,
  upstreamUrl: row.upstream_url,
  createdBy: row.created_by,
  createdAt: row.created_at.getTime(),
  seededAt: row.seeded_at ? row.seeded_at.getTime() : null,
});

const COLUMNS = "project_repository_id, base_sha, id, session_id, root_name, head_sha, upstream_url, created_by, created_at, seeded_at";

/** A room's imported repos, oldest first — stable order for pickers and lists. */
export async function listRoomRepos(sessionId: string): Promise<RoomRepo[]> {
  const rows = await query<RepoRow>(
    `SELECT ${COLUMNS} FROM room_repos WHERE session_id = $1 ORDER BY created_at`,
    [sessionId],
  );
  return rows.map(toRepo);
}

export async function getRoomRepo(repoId: string): Promise<RoomRepo | null> {
  const row = await queryOne<RepoRow>(
    `SELECT ${COLUMNS} FROM room_repos WHERE id = $1`,
    [repoId],
  );
  return row ? toRepo(row) : null;
}

/**
 * Create the record for a repo about to be imported. The id must be unique
 * across *both* tables that map ids to disk paths — a collision with a session
 * id would alias two repos onto one `repos/<id>.git` — hence the cross-table
 * probe inside the retry loop (the space is 33^12; this is belt and braces).
 *
 * Throws "name" when the room already has a repo by that name, so the route
 * can turn it into a 409 the composer understands.
 */
export async function createRoomRepo(input: {
  sessionId: string;
  projectRepositoryId?: string | null;
  rootName: string;
  createdBy: string;
}): Promise<RoomRepo> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = mintPathId();
    const taken = await queryOne<{ id: string }>(`SELECT id FROM sessions WHERE id = $1`, [id]);
    if (taken) continue;
    try {
      const row = await queryOne<RepoRow>(
        `INSERT INTO room_repos (id, session_id, root_name, created_by, project_repository_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [id, input.sessionId, input.rootName, input.createdBy, input.projectRepositoryId ?? null],
      );
      if (row) return toRepo(row);
    } catch (cause) {
      // Unique (session_id, root_name): the human-facing duplicate.
      if ((cause as { code?: string }).code === "23505") throw new Error("name");
      throw cause;
    }
  }
  throw new Error("Could not allocate a repo id.");
}

/** Mark the upload committed and record where its history starts. */
export async function finishRoomRepoSeed(
  repoId: string,
  input: { headSha: string; upstreamUrl: string | null },
): Promise<void> {
  await query(
    `UPDATE room_repos SET head_sha = $2, base_sha = $2, upstream_url = $3, seeded_at = now() WHERE id = $1`,
    [repoId, input.headSha, input.upstreamUrl],
  );
}

/** Advance an imported repo's head after an agent commit — its setHeadSha. */
export async function setRoomRepoHeadSha(repoId: string, headSha: string): Promise<void> {
  await query(`UPDATE room_repos SET head_sha = $2 WHERE id = $1`, [repoId, headSha]);
}
