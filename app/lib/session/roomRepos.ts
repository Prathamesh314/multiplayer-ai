/** Independently selected repositories inside a room; no mandatory project fork. */

import { rm } from "node:fs/promises";
import { query, queryOne, transaction } from "../db/client";
import { barePath, workPath } from "./paths";
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
  /** "private": only its creator sees it, its files and its chats. */
  visibility: RoomRepoVisibility;
};
export type RoomRepoVisibility = "room" | "private";

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
  visibility: RoomRepoVisibility;
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
  visibility: row.visibility ?? "room",
});

const COLUMNS = "project_repository_id, base_sha, id, session_id, root_name, head_sha, upstream_url, created_by, created_at, seeded_at, visibility";

/**
 * A room's imported repos, oldest first — stable order for pickers and lists.
 * With a viewer, private repos of other members are left out.
 */
export async function listRoomRepos(sessionId: string, viewerId?: string): Promise<RoomRepo[]> {
  const rows = await query<RepoRow>(
    `SELECT ${COLUMNS} FROM room_repos WHERE session_id = $1 AND ($2::uuid IS NULL OR NOT room_repo_hidden(id, $2)) ORDER BY created_at`,
    [sessionId, viewerId ?? null],
  );
  return rows.map(toRepo);
}

/** Whether a member may not see this repository (private, added by someone else). */
export const repoHiddenFrom = (repo: Pick<RoomRepo, "visibility" | "createdBy">, userId: string) =>
  repo.visibility === "private" && repo.createdBy !== userId;

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

export class RoomRepoError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/**
 * Its creator makes a repository private (only they see it and its chats) or
 * shows it to the room again. A repository other people already have chats
 * in cannot become private: that would hide their own chats from them.
 */
export async function setRoomRepoVisibility(sessionId: string, repoId: string, userId: string, visibility: unknown): Promise<RoomRepo> {
  if (visibility !== "room" && visibility !== "private") throw new RoomRepoError("Choose Private or Visible to the room.");
  return transaction(async (tx) => {
    const row = (await tx.query<RepoRow>(`SELECT ${COLUMNS} FROM room_repos WHERE id = $1 AND session_id = $2 FOR UPDATE`, [repoId, sessionId])).rows[0];
    if (!row || repoHiddenFrom(toRepo(row), userId)) throw new RoomRepoError("Repository not found in this room.", 404);
    if (row.created_by !== userId) throw new RoomRepoError("Only the person who added this repository can change who sees it.", 403);
    if (visibility === "private") {
      const others = (await tx.query<{ name: string }>(
        `SELECT DISTINCT u.display_name AS name FROM agent_runs r JOIN users u ON u.id = r.started_by
          WHERE r.repo_id = $1 AND (r.started_by <> $2 OR r.driver_user_id <> $2) ORDER BY 1 LIMIT 5`, [repoId, userId])).rows;
      if (others.length) throw new RoomRepoError(`${others.map((item) => item.name).join(", ")} ${others.length === 1 ? "has" : "have"} chats in this repository, so it stays visible to the room. Make a repository private before others start chats in it.`, 409);
    }
    const updated = (await tx.query<RepoRow>(`UPDATE room_repos SET visibility = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [repoId, visibility])).rows[0];
    return toRepo(updated);
  });
}

/**
 * Remove a repository from the room, with its chats. Allowed for the person
 * who added it, or the room's owner when it is visible to the room. Refused
 * while one of its chats is working or being handed over. A repository shared
 * from the project stays in the project; only this room's copy goes.
 */
export async function deleteRoomRepo(input: { sessionId: string; repoId: string; userId: string; roomOwner: boolean }): Promise<{ repo: RoomRepo; chats: number }> {
  const result = await transaction(async (tx) => {
    const row = (await tx.query<RepoRow>(`SELECT ${COLUMNS} FROM room_repos WHERE id = $1 AND session_id = $2 FOR UPDATE`, [input.repoId, input.sessionId])).rows[0];
    if (!row || repoHiddenFrom(toRepo(row), input.userId)) throw new RoomRepoError("Repository not found in this room.", 404);
    if (row.created_by !== input.userId && !input.roomOwner) throw new RoomRepoError("Only the person who added this repository, or the room’s owner, can delete it.", 403);
    const runs = (await tx.query<{ id: string }>(`SELECT id FROM agent_runs WHERE repo_id = $1 FOR UPDATE`, [input.repoId])).rows.map((run) => run.id);
    if (runs.length) {
      const busy = (await tx.query(`SELECT 1 FROM agent_turns WHERE run_id = ANY($1::uuid[]) AND status IN ('queued', 'running') LIMIT 1`, [runs])).rows.length
        || (await tx.query(`SELECT 1 FROM run_handoffs WHERE run_id = ANY($1::uuid[]) AND status = 'pending' AND expires_at > now() LIMIT 1`, [runs])).rows.length;
      if (busy) throw new RoomRepoError("A chat in this repository is working or being handed over. Wait for it to finish, then delete the repository.", 409);
      // Their chats go too: with the repository gone they would point at the room's own files.
      await tx.query(`DELETE FROM agent_runs WHERE id = ANY($1::uuid[])`, [runs]);
    }
    await tx.query(`DELETE FROM repo_context_index WHERE repo_ref = $1`, [input.repoId]);
    await tx.query(`DELETE FROM room_repos WHERE id = $1`, [input.repoId]);
    return { repo: toRepo(row), chats: runs.length };
  });
  return result;
}

/** After the record is gone: its Git data on disk. Best effort; an orphan directory holds nothing anyone can reach. */
export async function removeRoomRepoFiles(repoId: string) {
  await Promise.all([rm(barePath(repoId), { recursive: true, force: true }), rm(workPath(repoId), { recursive: true, force: true })]);
}
