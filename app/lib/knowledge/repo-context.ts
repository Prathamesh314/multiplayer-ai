/*
 * Repo-context indexing and recall — the knowledge graph's repo node.
 *
 * The project's canonical `main` is distilled (repo-summary.ts) into a per-SHA
 * mnemosyne bank, so an agent prompt can recall "how is this codebase shaped"
 * facts the same way it recalls conversation memory. Keying the bank by SHA
 * makes staleness structural instead of a cleanup job: when `main` advances,
 * the pointer row moves to the new bank and the old one is simply never
 * queried again — no delete API needed on the vector store.
 *
 * Indexing is deliberately off the run's critical path. `recallRepoContext`
 * reads whichever SHA is already indexed and *kicks* a reindex in the
 * background when `main` has moved on; the freshly published code becomes
 * recallable on the next run. Rooms also diverge from `main` while they work —
 * repo context is orientation (layout, conventions, API surface), not the
 * agent's source of truth for file contents; the agent has the working copy
 * itself for that.
 *
 * Fail-open like the rest of the memory layer: no sidecar, no git repo, or any
 * error → empty results, and the run proceeds unchanged.
 */

import { query, queryOne } from "../db/client";
import { memoryEnabled, recall, remember } from "../ai/mnemosyne";
import type { Memory } from "../ai/mnemosyne";
import { listProjectFiles, projectHeadSha, readProjectFileText } from "../session/repo";
import { repoBank } from "./graph";
import { chooseSampleFiles, summarizeRepo } from "./repo-summary";

/** Recall breadth for the repo bank; one bank, so one call either way. */
const REPO_TOP_K = 5;
/** Indexed chunks are orientation, not prose — importance sits above chat noise. */
const CHUNK_IMPORTANCE = 0.7;

/** The `main` SHA whose bank is currently queryable, or null before first index. */
export async function indexedRepoSha(projectId: string): Promise<string | null> {
  const row = await queryOne<{ head_sha: string }>(
    `SELECT head_sha FROM repo_context_index WHERE project_id = $1`,
    [projectId],
  );
  return row?.head_sha ?? null;
}

/** In-process re-entrancy guard; the SQL claim below handles cross-process races. */
const indexing = new Set<string>();

/**
 * Bring the project's repo bank up to `main`'s HEAD, if it isn't already.
 * Safe to fire-and-forget from anywhere: it exits in one SQL round-trip when
 * the index is current, and every failure mode is swallowed.
 *
 * The claim is an upsert that only returns a row when the stored SHA actually
 * changes, so two servers racing here do the distillation once. A crash after
 * the claim leaves a partially filled bank — accepted: recall degrades, and the
 * next advance of `main` rebuilds a fresh bank from scratch.
 */
export async function ensureRepoIndexed(projectId: string): Promise<void> {
  if (!memoryEnabled() || indexing.has(projectId)) return;
  indexing.add(projectId);
  try {
    const sha = await projectHeadSha(projectId);
    if (!sha) return;

    const claimed = await queryOne<{ head_sha: string }>(
      `INSERT INTO repo_context_index (project_id, head_sha)
       VALUES ($1, $2)
       ON CONFLICT (project_id) DO UPDATE
          SET head_sha = EXCLUDED.head_sha, indexed_at = now()
        WHERE repo_context_index.head_sha IS DISTINCT FROM EXCLUDED.head_sha
       RETURNING head_sha`,
      [projectId, sha],
    );
    if (!claimed) return; // already indexed at this HEAD

    const paths = await listProjectFiles(projectId);
    if (paths.length === 0) return;

    const files = new Map<string, string>();
    for (const path of chooseSampleFiles(paths)) {
      const text = await readProjectFileText(projectId, path);
      if (text) files.set(path, text);
    }

    const bank = repoBank(projectId, sha);
    for (const chunk of summarizeRepo({ paths, files })) {
      await remember({
        bank,
        content: chunk.content,
        importance: CHUNK_IMPORTANCE,
        channelId: `repo:${sha.slice(0, 12)}`,
        source: "repo",
      });
    }
  } catch {
    // Fail-open: a missing repo or a down sidecar costs context, never a run.
  } finally {
    indexing.delete(projectId);
  }
}

/**
 * Recall repo-context memories relevant to one prompt, from the *indexed*
 * SHA's bank (which may trail `main` briefly while a background reindex runs).
 * Kicks that reindex on every call — it is one SQL round-trip when current.
 */
export async function recallRepoContext(projectId: string, prompt: string): Promise<Memory[]> {
  if (!memoryEnabled() || !prompt.trim()) return [];
  const sha = await indexedRepoSha(projectId);
  void ensureRepoIndexed(projectId); // never throws; see above
  if (!sha) return [];
  return recall({ bank: repoBank(projectId, sha), query: prompt, topK: REPO_TOP_K });
}

/** Drop a project's index pointer (retention/debug); the orphaned bank just ages out. */
export async function forgetRepoIndex(projectId: string): Promise<void> {
  await query(`DELETE FROM repo_context_index WHERE project_id = $1`, [projectId]);
}
