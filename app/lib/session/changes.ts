import { queryOne } from "../db/client";
import { committedChanges, diffFilesBare, diffPath } from "./repo";
import type { ChangedFile, ChangesResponse } from "./types";

type LiveSnapshot = { snapshot_sha: string; captured_at: Date; run_id: string; title: string | null };
type Repository = { ref: string; baseSha: string; headSha: string };

/**
 * What the room's Changes tab compares against its import baseline. While an
 * agent works on this repository, that is its latest worktree checkpoint
 * rather than the room head, so files appear as the agent writes them, the
 * way a local worktree would show them. Only a running chat that started from
 * the current head counts: its checkpoint holds everything committed here
 * plus its own work in progress. Parallel chats have their own Changes view.
 */
export async function liveSnapshot(sessionId: string, repo: Repository, viewerId: string) {
  return queryOne<LiveSnapshot>(
    `SELECT s.snapshot_sha, s.captured_at, r.id AS run_id, r.title
       FROM workspace_snapshots s
       JOIN agent_turns t ON t.id = s.turn_id
       JOIN agent_runs r ON r.id = s.run_id
      WHERE s.session_id = $1 AND s.repo_ref = $2 AND s.base_sha = $3 AND t.status = 'running'
        AND r.isolation <> 'isolated' AND NOT agent_run_hidden(r.id, $4)
      ORDER BY s.captured_at DESC, s.sequence DESC LIMIT 1`,
    [sessionId, repo.ref, repo.headSha, viewerId],
  );
}

/** Every changed file with its line counts, plus totals and the live chat, if any. */
export async function roomChanges(sessionId: string, repo: Repository, viewerId: string): Promise<ChangesResponse> {
  const live = await liveSnapshot(sessionId, repo, viewerId);
  const head = live?.snapshot_sha ?? repo.headSha;
  const [statuses, counts] = await Promise.all([committedChanges(repo.ref, repo.baseSha, head), diffFilesBare(repo.ref, repo.baseSha, head)]);
  const lines = new Map(counts.map((file) => [file.path, file]));
  const changes: ChangedFile[] = statuses.map((file) => {
    const counted = lines.get(file.path);
    return { ...file, added: counted?.added ?? 0, removed: counted?.removed ?? 0, ...(counted?.binary ? { binary: true } : {}) };
  });
  return {
    changes,
    head,
    totals: { files: changes.length, added: changes.reduce((sum, file) => sum + (file.added ?? 0), 0), removed: changes.reduce((sum, file) => sum + (file.removed ?? 0), 0) },
    live: live ? { runId: live.run_id, title: live.title, capturedAt: new Date(live.captured_at).getTime() } : null,
  };
}

/** One file's unified diff, against the same two commits as `roomChanges`. */
export async function roomChangeDiff(sessionId: string, repo: Repository, viewerId: string, path: string): Promise<string> {
  const live = await liveSnapshot(sessionId, repo, viewerId);
  return diffPath(repo.ref, repo.baseSha, live?.snapshot_sha ?? repo.headSha, path);
}
