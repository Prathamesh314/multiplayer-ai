/*
 * Repo-context indexing and recall — per repo, on approval.
 *
 * Before the AI changes code it should understand the repo it is changing;
 * after the human approves the work, the understanding must be refreshed.
 * This module holds both halves for every kind of repo a chat can target:
 *
 *   ref kind          bank source                updated when
 *   ────────────────  ─────────────────────────  ─────────────────────────────
 *   project (uuid)    canonical main             publish — the approval event
 *   room fork (id)    the fork's session branch  publish of that room, too
 *   imported (id)     its session branch         run completion — the only
 *   personal room                                "approved" where no publish
 *                                                flow exists (mirrors the
 *                                                shared-memory gating rule)
 *
 * Reads never trigger indexing of unapproved work: `recallRepoContext` only
 * queries banks whose pointer row exists, and the background `ensure` kick on
 * the read path is limited to the project's main (approved by definition).
 * Banks stay keyed per SHA (`repo-<ref>-<sha12>`), so an update *moves* the
 * pointer and orphans the stale bank rather than mixing histories.
 *
 * Fail-open like the rest of the memory layer: no sidecar, no git repo, or
 * any error → empty results, and the run proceeds unchanged.
 */

import { query, queryOne } from "../db/client";
import { memoryEnabled, recall, remember } from "../ai/mnemosyne";
import type { Memory } from "../ai/mnemosyne";
import {
  listProjectFiles,
  listRepoRefFiles,
  projectHeadSha,
  readProjectFileText,
  readRepoRefFileText,
  repoRefHeadSha,
} from "../session/repo";
import { isSessionId } from "../session/paths";
import { repoBank } from "./graph";
import { chooseSampleFiles, summarizeRepo } from "./repo-summary";

/** Recall breadth per bank; a chat queries at most two (target repo + main). */
const REPO_TOP_K = 5;
/** Indexed chunks are orientation, not prose — importance sits above chat noise. */
const CHUNK_IMPORTANCE = 0.7;

/** The ref's current head, resolved by what kind of repo it names. */
async function refHeadSha(ref: string): Promise<string | null> {
  return isSessionId(ref) ? repoRefHeadSha(ref) : projectHeadSha(ref);
}

/** The SHA whose bank is currently queryable for a ref, or null before first index. */
export async function indexedRepoSha(ref: string): Promise<string | null> {
  const row = await queryOne<{ head_sha: string }>(
    `SELECT head_sha FROM repo_context_index WHERE repo_ref = $1`,
    [ref],
  );
  return row?.head_sha ?? null;
}

/** In-process re-entrancy guard; the SQL claim below handles cross-process races. */
const indexing = new Set<string>();

/**
 * Bring a repo's context bank up to its current head, if it isn't already.
 * Called only from approval points (publish; completion where no publish flow
 * exists) plus the read-path kick for project main. Safe to fire-and-forget:
 * one SQL round-trip when current, every failure mode swallowed.
 *
 * The claim is an upsert that only returns a row when the stored SHA actually
 * changes, so two servers racing here do the distillation once. A crash after
 * the claim leaves a partially filled bank — accepted: recall degrades, and
 * the next approved change rebuilds a fresh bank from scratch.
 */
export async function ensureRepoContext(ref: string): Promise<void> {
  if (!memoryEnabled() || indexing.has(ref)) return;
  indexing.add(ref);
  try {
    const sha = await refHeadSha(ref);
    if (!sha) return;

    const claimed = await queryOne<{ head_sha: string }>(
      `INSERT INTO repo_context_index (repo_ref, head_sha)
       VALUES ($1, $2)
       ON CONFLICT (repo_ref) DO UPDATE
          SET head_sha = EXCLUDED.head_sha, indexed_at = now()
        WHERE repo_context_index.head_sha IS DISTINCT FROM EXCLUDED.head_sha
       RETURNING head_sha`,
      [ref, sha],
    );
    if (!claimed) return; // already indexed at this head

    const roomRef = isSessionId(ref);
    const paths = roomRef ? await listRepoRefFiles(ref) : await listProjectFiles(ref);
    if (paths.length === 0) return;

    const files = new Map<string, string>();
    for (const path of chooseSampleFiles(paths)) {
      const text = roomRef
        ? await readRepoRefFileText(ref, path)
        : await readProjectFileText(ref, path);
      if (text) files.set(path, text);
    }

    const bank = repoBank(ref, sha);
    let stored = 0;
    for (const chunk of summarizeRepo({ paths, files })) {
      const ok = await remember({
        bank,
        content: chunk.content,
        importance: CHUNK_IMPORTANCE,
        channelId: `repo-${sha.slice(0, 12)}`,
        source: "repo",
        // Indexing runs in the background; a cold sidecar loading its
        // embedding model deserves patience here, not a dropped write.
        timeoutMs: 30_000,
      });
      if (ok) stored += 1;
    }
    // The pointer claimed before the writes (stampede control). If nothing at
    // all landed — sidecar down or still cold — roll it back so the next
    // approval retries instead of pointing forever at an empty bank.
    if (stored === 0) {
      await query(`DELETE FROM repo_context_index WHERE repo_ref = $1 AND head_sha = $2`, [
        ref,
        sha,
      ]).catch(() => {});
    }
  } catch {
    // Fail-open: a missing repo or a down sidecar costs context, never a run.
  } finally {
    indexing.delete(ref);
  }
}

/** Kept for the project read-path kick; same function, project-shaped name. */
export const ensureRepoIndexed = ensureRepoContext;

/**
 * Recall context relevant to one prompt from every given ref's *indexed* bank
 * — the chat's target repo first, the project's canonical main alongside.
 * Refs without a pointer row contribute nothing (their first index arrives
 * with their first approval); duplicates are queried once.
 */
export async function recallRepoContext(refs: string[], prompt: string): Promise<Memory[]> {
  if (!memoryEnabled() || !prompt.trim()) return [];
  const distinct = [...new Set(refs.filter(Boolean))];
  const hits = await Promise.all(
    distinct.map(async (ref) => {
      const sha = await indexedRepoSha(ref);
      if (!sha) return [];
      return recall({ bank: repoBank(ref, sha), query: prompt, topK: REPO_TOP_K });
    }),
  );
  return hits.flat();
}

/** Drop a ref's index pointer (retention/debug); the orphaned bank just ages out. */
export async function forgetRepoIndex(ref: string): Promise<void> {
  await query(`DELETE FROM repo_context_index WHERE repo_ref = $1`, [ref]);
}
