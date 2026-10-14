import { withApiLimit } from "../../../../../../lib/http/api-limit";
import { withStoredRepo } from "../../../../../../lib/storage/git-cache";
import { access, denied } from "../../../../../../lib/session/auth";
import { getRun } from "../../../../../../lib/ai/runs";
import { isUuid } from "../../../../../../lib/ai/turns";
import { query, transaction } from "../../../../../../lib/db/client";
import { activityPage } from "../../../../../../lib/runner/activity";
import { listCheckpoints, getCheckpoint } from "../../../../../../lib/runner/checkpoints";
import { committedChanges, listCommittedTree, readCommittedBytes } from "../../../../../../lib/session/repo";
import { objectText } from "../../../../../../lib/git/objects";
import { barePath, safeRelativePath } from "../../../../../../lib/session/paths";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; runId: string }> };

async function gate(context: Context) {
  const { id, runId } = await context.params;
  const result = await access(id); const refusal = denied(result);
  if (refusal || !result) return refusal!;
  const run = isUuid(runId) ? await getRun(runId) : null;
  if (!run || run.sessionId !== id) return Response.json({ error: "Chat not found." }, { status: 404 });
  return { result, run };
}
async function handleGET(request: Request, context: Context) {
  const gated = await gate(context); if (gated instanceof Response) return gated;
  const { run } = gated, url = new URL(request.url);
  const snapshotId = url.searchParams.get("snapshot");
  if (snapshotId) {
    const snapshot = isUuid(snapshotId) ? await getCheckpoint(snapshotId, run.id) : null;
    if (!snapshot || snapshot.repoRef !== (run.repoId ?? run.sessionId)) return Response.json({ error: "Checkpoint not found." }, { status: 404 });
    return withStoredRepo(barePath(snapshot.repoRef), async () => {
    const path = url.searchParams.get("path");
    if (path !== null) {
      if (!safeRelativePath(path)) return Response.json({ error: "Invalid file path." }, { status: 400 });
      const bytes = await readCommittedBytes(snapshot.repoRef, snapshot.snapshotSha, path);
      const diff = await objectText(barePath(snapshot.repoRef), ["diff", "--no-ext-diff", "--no-textconv", snapshot.baseSha, snapshot.snapshotSha, "--", path]);
      const binary = bytes?.subarray(0,4096).includes(0) ?? false;
      return Response.json({ diff: diff.slice(0, 2 * 1024 * 1024), text: !bytes || binary ? "" : bytes.subarray(0, 2 * 1024 * 1024).toString(), binary, truncated: (bytes?.length ?? 0) > 2 * 1024 * 1024 });
    }
    return Response.json({ snapshot, tree: await listCommittedTree(snapshot.repoRef, "Snapshot", snapshot.snapshotSha),
      changes: await committedChanges(snapshot.repoRef, snapshot.baseSha, snapshot.snapshotSha),
      diff: (await objectText(barePath(snapshot.repoRef), ["diff", "--no-ext-diff", "--no-textconv", "--stat", snapshot.baseSha, snapshot.snapshotSha])).slice(0,65536) }, { headers: { "cache-control": "no-store" } });
    });
  }
  const turnId = url.searchParams.get("turn");
  if (turnId) {
    const turns = isUuid(turnId) ? await query(`SELECT id FROM agent_turns WHERE id = $1 AND run_id = $2`, [turnId, run.id]) : [];
    if (!turns.length) return Response.json({ error: "Turn not found." }, { status: 404 });
    const after = Number(url.searchParams.get("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return Response.json({ error: "Invalid cursor." }, { status: 400 });
    const batches = await activityPage(turnId, after);
    return Response.json({ batches, next: batches.at(-1)?.sequence ?? after }, { headers: { "cache-control": "no-store" } });
  }
  const turns = await query(`SELECT t.id, t.status, t.created_at AS "createdAt", MAX(b.created_at) AS "syncedAt", COALESCE(MAX(b.sequence),0)::int AS sequence
    FROM agent_turns t LEFT JOIN run_activity_batches b ON b.turn_id = t.id WHERE t.run_id = $1 GROUP BY t.id ORDER BY t.created_at DESC LIMIT 100`, [run.id]);
  return Response.json({ turns, snapshots: await listCheckpoints(run.id), selectedSnapshotId: run.restoreSnapshotId ?? null }, { headers: { "cache-control": "no-store" } });
}
async function handlePOST(request: Request, context: Context) {
  const gated = await gate(context); if (gated instanceof Response) return gated;
  const { run, result } = gated;
  const body = await request.json().catch(() => null);
  if (!body || (body.snapshotId !== null && !isUuid(body.snapshotId)) || !Number.isSafeInteger(body.version)) return Response.json({ error: "Expected checkpoint and control version." }, { status: 400 });
  try {
    await transaction(async tx => {
      const { rows: [current] } = await tx.query(`SELECT *, room_access_role(session_id,$2) AS role FROM agent_runs WHERE id = $1 FOR UPDATE`, [run.id, result.user.id]);
      if (!current || !["owner","editor"].includes(current.role) || current.driver_user_id !== result.user.id || current.control_version !== body.version) throw new Error("Take control of this chat before selecting a checkpoint.");
      if (["running","queued"].includes(current.status)) throw new Error("Finish or recover the active turn before restoring.");
      if (body.snapshotId) {
        const { rows: [snapshot] } = await tx.query(`SELECT * FROM workspace_snapshots WHERE id = $1 AND run_id = $2 AND repo_ref = $3`, [body.snapshotId, run.id, run.repoId ?? run.sessionId]);
        // An isolated chat restores against its own branch, not the room's.
        const head = current.isolation === "isolated" ? current.head_sha
          : (await tx.query(run.repoId ? `SELECT head_sha FROM room_repos WHERE id = $1` : `SELECT head_sha FROM session_repos WHERE session_id = $1`, [run.repoId ?? run.sessionId])).rows[0]?.head_sha;
        if (!snapshot || (snapshot.base_sha !== head && snapshot.head_sha !== head)) throw new Error("Repository history advanced beyond this checkpoint. Review its files before integrating it; no code was changed.");
      }
      await tx.query(`UPDATE agent_runs SET restore_snapshot_id = $2 WHERE id = $1`, [run.id, body.snapshotId]);
    });
    return Response.json({ ok: true });
  } catch (cause) { return Response.json({ error: cause instanceof Error ? cause.message : "Checkpoint not selected." }, { status: 409 }); }
}

export const GET = withApiLimit("/api/sessions/[id]/runs/[runId]/history", handleGET);
export const POST = withApiLimit("/api/sessions/[id]/runs/[runId]/history", handlePOST);
