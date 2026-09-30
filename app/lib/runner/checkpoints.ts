import { withStoredRepo } from "../storage/git-cache";
import { query, queryOne } from "../db/client";
import { objectText } from "../git/objects";
import { barePath } from "../session/paths";
import { isUuid } from "../ai/turns";
import type { AgentRunJob } from "../ai/run-events";
import { checkpointRef, type Checkpoint } from "./checkpoint-types";
export type SavedCheckpoint = Checkpoint & { runId: string; repoRef: string; syncedAt: string };
const columns = `id, turn_id AS "turnId", sequence, base_sha AS "baseSha", head_sha AS "headSha", index_sha AS "indexSha", snapshot_sha AS "snapshotSha", captured_at AS "capturedAt", created_at AS "syncedAt", run_id AS "runId", repo_ref AS "repoRef"`;
export function validCheckpoint(value: unknown): value is Checkpoint {
  const s = value as Checkpoint;
  return !!s && isUuid(s.id) && isUuid(s.turnId) && Number.isSafeInteger(s.sequence) && s.sequence >= 1 && s.sequence <= 120 &&
    [s.baseSha, s.headSha, s.indexSha, s.snapshotSha].every(sha => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)) && typeof s.capturedAt === "string" && Number.isFinite(Date.parse(s.capturedAt));
}
async function saveStoredCheckpoint(job: AgentRunJob, deviceId: string, snapshot: Checkpoint) {
  if (!validCheckpoint(snapshot) || snapshot.turnId !== job.turnId || snapshot.baseSha !== job.baseSha) throw new Error("Invalid checkpoint identity.");
  const ref = job.repoId ?? job.sessionId, bare = barePath(ref);
  if (await objectText(bare, ["rev-parse", checkpointRef(snapshot)]) !== snapshot.snapshotSha) throw new Error("Checkpoint upload is incomplete.");
  if (await objectText(bare, ["show", "-s", "--format=%P", snapshot.snapshotSha]) !== `${snapshot.headSha} ${snapshot.indexSha}` ||
      await objectText(bare, ["show", "-s", "--format=%P", snapshot.indexSha]) !== snapshot.headSha) throw new Error("Invalid checkpoint graph.");
  await objectText(bare, ["merge-base", "--is-ancestor", job.baseSha, snapshot.headSha]);
  await query(`INSERT INTO workspace_snapshots(id, turn_id, run_id, session_id, repo_ref, device_id, sequence, base_sha, head_sha, index_sha, snapshot_sha, captured_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (turn_id,sequence) DO NOTHING`,
  [snapshot.id, job.turnId, job.runId, job.sessionId, ref, deviceId, snapshot.sequence, snapshot.baseSha, snapshot.headSha, snapshot.indexSha, snapshot.snapshotSha, snapshot.capturedAt]);
  const existing = await queryOne<{ snapshot_sha: string }>(`SELECT snapshot_sha FROM workspace_snapshots WHERE turn_id = $1 AND sequence = $2`, [job.turnId, snapshot.sequence]);
  if (existing?.snapshot_sha !== snapshot.snapshotSha) throw new Error("Checkpoint sequence was already used.");
}
export async function listCheckpoints(runId: string) {
  return query<SavedCheckpoint>(`SELECT ${columns} FROM workspace_snapshots WHERE run_id = $1 ORDER BY created_at DESC LIMIT 120`, [runId]);
}
export async function getCheckpoint(id: string, runId: string) {
  return queryOne<SavedCheckpoint>(`SELECT ${columns} FROM workspace_snapshots WHERE id = $1 AND run_id = $2`, [id, runId]);
}

export const saveCheckpoint = (...args: Parameters<typeof saveStoredCheckpoint>) => withStoredRepo(barePath(args[0].repoId ?? args[0].sessionId), () => saveStoredCheckpoint(...args));
