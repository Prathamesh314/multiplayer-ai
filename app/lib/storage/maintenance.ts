import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot, barePath, workPath } from "../session/paths";
import { withRepoLock } from "../session/repo";
import { withStoredRepo } from "./git-cache";
import { objectText } from "../git/objects";
import { query, transaction } from "../db/client";

/** Old server checkouts are removed only when every local ref is retained by the bare repo. */
export async function cleanLegacyWork(apply = false) {
  const result: { id: string; action: string; reason?: string }[] = [];
  for (const entry of await readdir(join(dataRoot(), "work"), { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name) || entry.name.startsWith("turn-")) continue;
    const id = entry.name, work = workPath(id), bare = barePath(id);
    await withStoredRepo(bare, () => withRepoLock(id, async () => {
      try {
        if (!(await lstat(join(work,".git"))).isDirectory()) throw new Error("Not an ordinary legacy checkout");
        if (await objectText(work,["status","--porcelain","--untracked-files=all","--ignored"])) throw new Error("Contains unfinished, untracked or ignored files");
        const heads = (await objectText(work,["for-each-ref","--format=%(objectname)",])).split("\n").filter(Boolean);
        heads.push(await objectText(work,["rev-parse","HEAD"]));
        heads.push(...(await objectText(work,["reflog","--format=%H","--all"])).split("\n").filter(Boolean));
        for (const sha of new Set(heads)) {
          if (!await objectText(bare,["for-each-ref",`--contains=${sha}`,"--format=%(refname)"])) throw new Error("Contains commits not retained by the server");
        }
        if (apply) await rm(work,{recursive:true,force:true});
        result.push({id,action:apply?"removed":"safe to remove"});
      } catch (cause) { result.push({id,action:"preserved",reason:cause instanceof Error?cause.message:String(cause)}); }
    }));
  }
  return result;
}

/** Keep the latest checkpoint of every turn and anything explicitly queued for restoration. */
export async function pruneCheckpoints(days = 7) {
  if (!Number.isFinite(days) || days < 1) throw new Error("Invalid checkpoint retention.");
  const expired = await query<{ id: string; repo_ref: string; turn_id: string; sequence: number }>(`SELECT s.id,s.repo_ref,s.turn_id,s.sequence FROM workspace_snapshots s
    WHERE s.created_at < now() - make_interval(days => $1::int)
      AND EXISTS (SELECT 1 FROM workspace_snapshots newer WHERE newer.turn_id=s.turn_id AND newer.sequence>s.sequence)
      AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.restore_snapshot_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM run_handoffs h WHERE h.snapshot_id=s.id)
      AND NOT EXISTS (SELECT 1 FROM agent_turns t WHERE t.status IN ('preparing','queued','running') AND t.payload->'restoreCheckpoint'->>'id'=s.id)
    LIMIT 100`,[days]);
  for (const row of expired) await withStoredRepo(barePath(row.repo_ref), () => withRepoLock(row.repo_ref, async () => {
    const removed = await transaction(async tx => {
      const { rows } = await tx.query(`SELECT id FROM workspace_snapshots WHERE id=$1 FOR UPDATE`,[row.id]);
      if (!rows.length) return false;
      const { rows: pinned } = await tx.query(`SELECT 1 FROM agent_runs WHERE restore_snapshot_id=$1
        UNION ALL SELECT 1 FROM run_handoffs WHERE snapshot_id=$1
        UNION ALL SELECT 1 FROM agent_turns WHERE status IN ('preparing','queued','running') AND payload->'restoreCheckpoint'->>'id'=$1::text`,[row.id]);
      if (pinned.length) return false;
      await tx.query(`DELETE FROM workspace_snapshots WHERE id=$1`,[row.id]);
      return true;
    });
    // A failed ref deletion leaks storage, not user data. Git GC keeps its grace period.
    if (removed) await objectText(barePath(row.repo_ref),["update-ref","-d",`refs/checkpoints/${row.turn_id}/${row.sequence}`]);
  }));
  return expired.length;
}
