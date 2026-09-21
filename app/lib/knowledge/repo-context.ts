import { query, queryOne, transaction } from "../db/client";
import type { Memory } from "../ai/mnemosyne";
import { projectHeadSha, repoRefHeadSha, repoSnapshotDiff, repoSnapshotPaths, repoSnapshotText } from "../session/repo";
import { isSessionId } from "../session/paths";
import { queueEnabled } from "../queue";
import { chunkSource, identifierText, indexableSourcePath, INDEX_VERSION } from "./repo-chunks";
import { embedRepoTexts, repoEmbeddingConfig } from "./repo-embeddings";

const REPO_TOP_K = 5;
const CANDIDATES = 30;

export async function indexedRepoSha(ref: string): Promise<string | null> {
  const row = await queryOne<{ head_sha: string }>(
    `SELECT head_sha FROM repo_context_index WHERE repo_ref = $1 AND index_version = $2`, [ref, INDEX_VERSION]);
  return row?.head_sha ?? null;
}

/** Approval points enqueue immutable SHAs. Only project main may be kicked
 * from the read path; room/import context remains approval-gated. */
export async function ensureRepoContext(ref: string, approvedSha?: string): Promise<void> {
  try {
    const sha = approvedSha ?? await (isSessionId(ref) ? repoRefHeadSha(ref) : projectHeadSha(ref));
    if (!sha) return;
    await query(`INSERT INTO repo_context_jobs(repo_ref, head_sha)
      SELECT $1, $2 WHERE NOT EXISTS (
        SELECT 1 FROM repo_context_index WHERE repo_ref = $1 AND head_sha = $2 AND index_version = $3
      ) OR EXISTS (SELECT 1 FROM repo_context_jobs WHERE repo_ref = $1)
      ON CONFLICT (repo_ref) DO UPDATE SET head_sha = EXCLUDED.head_sha,
        requested_at = EXCLUDED.requested_at, retry_at = now(), last_error = NULL
      WHERE repo_context_jobs.requested_at <= EXCLUDED.requested_at`, [ref, sha, INDEX_VERSION]);
    if (!queueEnabled()) {
      void drainRepoContext(ref);
    }
  } catch (cause) {
    console.warn("Repo context indexing deferred", cause instanceof Error ? cause.message : cause);
  }
}
export const ensureRepoIndexed = ensureRepoContext;

const draining = new Set<string>();
/** Inline fallback. The worker uses the same durable queue after a restart. */
async function drainRepoContext(ref: string): Promise<void> {
  if (draining.has(ref)) return;
  draining.add(ref);
  try {
    while (await indexNextRepoJob(ref) || await embedPendingRepoChunks(ref)) { /* drain */ }
  } catch (cause) {
    console.warn("Repo context background work deferred", cause instanceof Error ? cause.message : cause);
  } finally {
    draining.delete(ref);
  }
}

/** Publish chunks and their pointer atomically. The job row serializes builds
 * and approval requests. A failed read rolls everything back for retry. */
export async function indexNextRepoJob(ref?: string): Promise<boolean> {
  let attempted: string | undefined;
  try {
    return await transaction(async (tx) => {
      const job = (await tx.query<{ repo_ref: string; head_sha: string }>(
        `SELECT repo_ref, head_sha FROM repo_context_jobs
         WHERE ($1::text IS NULL OR repo_ref = $1) AND retry_at <= now()
         ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [ref ?? null])).rows[0];
      if (!job) return false;
      attempted = job.repo_ref;
      const previous = (await tx.query<{ head_sha: string; index_version: number }>(
        `SELECT head_sha, index_version FROM repo_context_index WHERE repo_ref = $1`, [job.repo_ref])).rows[0];
      const paths = (await repoSnapshotPaths(job.repo_ref, job.head_sha)).filter(indexableSourcePath);
      const live = new Set(paths);
      let changed = paths;
      let full = !previous || previous.index_version !== INDEX_VERSION;
      if (!full) {
        try { changed = await repoSnapshotDiff(job.repo_ref, previous.head_sha, job.head_sha); }
        catch { full = true; } // old commit pruned: rebuild the immutable target
      }
      if (full) changed = paths;
      await tx.query(`INSERT INTO repo_context_index(repo_ref, head_sha, index_version)
        VALUES ($1, $2, $3) ON CONFLICT (repo_ref) DO NOTHING`, [job.repo_ref, job.head_sha, INDEX_VERSION]);
      if (full) {
        await tx.query(`DELETE FROM repo_context_chunks WHERE repo_ref = $1`, [job.repo_ref]);
        await tx.query(`DELETE FROM repo_context_skipped_files WHERE repo_ref = $1`, [job.repo_ref]);
      }
      for (const path of changed) {
        const old = (await tx.query<{ chunk_id: string; embedding: string | null; embedding_key: string | null }>(
          `DELETE FROM repo_context_chunks WHERE repo_ref = $1 AND path = $2
           RETURNING chunk_id, embedding, embedding_key`, [job.repo_ref, path])).rows;
        await tx.query(`DELETE FROM repo_context_skipped_files WHERE repo_ref = $1 AND path = $2`, [job.repo_ref, path]);
        if (!live.has(path)) continue;
        const text = await repoSnapshotText(job.repo_ref, job.head_sha, path);
        if (text === null) {
          await tx.query(`INSERT INTO repo_context_skipped_files(repo_ref, path) VALUES ($1, $2)`, [job.repo_ref, path]);
          continue;
        }
        const reusable = new Map(old.map((chunk) => [chunk.chunk_id, chunk]));
        const chunks = chunkSource(path, text);
        for (let offset = 0; offset < chunks.length; offset += 100) {
          const rows = chunks.slice(offset, offset + 100).map((chunk, index) => ({
            chunk_id: chunk.id, chunk_index: offset + index, path: chunk.path,
            start_line: chunk.startLine, end_line: chunk.endLine, symbol_name: chunk.symbol,
            content: chunk.content, search_text: chunk.searchText,
            embedding: reusable.get(chunk.id)?.embedding ?? null,
            embedding_key: reusable.get(chunk.id)?.embedding_key ?? null,
          }));
          await tx.query(`INSERT INTO repo_context_chunks
            (repo_ref, chunk_id, chunk_index, path, start_line, end_line, symbol_name, content, search_text, embedding, embedding_key)
            SELECT $1, x.chunk_id, x.chunk_index, x.path, x.start_line, x.end_line, x.symbol_name,
              x.content, x.search_text, x.embedding::vector, x.embedding_key
            FROM jsonb_to_recordset($2::jsonb) AS x(chunk_id text, chunk_index integer, path text,
              start_line integer, end_line integer, symbol_name text, content text, search_text text,
              embedding text, embedding_key text)`, [job.repo_ref, JSON.stringify(rows)]);
        }
      }
      await tx.query(`UPDATE repo_context_index SET head_sha = $2, index_version = $3,
        indexed_at = now(), skipped_files = (SELECT count(*) FROM repo_context_skipped_files WHERE repo_ref = $1)
        WHERE repo_ref = $1`, [job.repo_ref, job.head_sha, INDEX_VERSION]);
      await tx.query(`DELETE FROM repo_context_jobs WHERE repo_ref = $1`, [job.repo_ref]);
      return true;
    });
  } catch (cause) {
    if (attempted) await query(`UPDATE repo_context_jobs SET retry_at = now() + interval '30 seconds',
      last_error = $2 WHERE repo_ref = $1`, [attempted, cause instanceof Error ? cause.message : "Index failed"]).catch(() => {});
    throw cause;
  }
}

/** Retryable vectors are attached by content identity, so an in-flight
 * response cannot attach to edited or deleted source. */
export async function embedPendingRepoChunks(ref?: string): Promise<boolean> {
  const config = repoEmbeddingConfig();
  if (!config) return false;
  const rows = await query<{ repo_ref: string; chunk_id: string; path: string; symbol_name: string; content: string }>(
    `SELECT DISTINCT repo_ref, chunk_id, path, symbol_name, content FROM repo_context_chunks
     WHERE ($1::text IS NULL OR repo_ref = $1) AND embedding_key IS DISTINCT FROM $2
     ORDER BY repo_ref, chunk_id LIMIT 32`, [ref ?? null, config.key]);
  if (!rows.length) return false;
  const vectors = await embedRepoTexts(config, rows.map((row) => `${row.path}\n${row.symbol_name}\n${row.content}`));
  await transaction(async (tx) => {
    for (let i = 0; i < rows.length; i++) {
      await tx.query(`UPDATE repo_context_chunks SET embedding = $3::vector, embedding_key = $4
        WHERE repo_ref = $1 AND chunk_id = $2`, [rows[i].repo_ref, rows[i].chunk_id, JSON.stringify(vectors[i]), config.key]);
    }
  });
  return true;
}

type Hit = { repo_ref: string; head_sha: string; chunk_id: string; path: string;
  start_line: number; end_line: number; symbol_name: string; content: string; exact?: boolean };

/** Reciprocal-rank fusion combines ranks, not incomparable raw scores. */
export function fuseRepoHits(lexical: Hit[], semantic: Hit[], limit = REPO_TOP_K): Memory[] {
  const hits = new Map<string, { hit: Hit; score: number; exact: boolean }>();
  for (const list of [lexical, semantic]) list.forEach((hit, rank) => {
    const key = `${hit.repo_ref}:${hit.head_sha}:${hit.path}:${hit.start_line}:${hit.chunk_id}`;
    const entry = hits.get(key) ?? { hit, score: 0, exact: false };
    entry.score += 1 / (60 + rank + 1);
    entry.exact ||= !!hit.exact;
    hits.set(key, entry);
  });
  return [...hits.values()].sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score)
    .slice(0, limit).map(({ hit, score }) => ({
      content: `[repo ${hit.repo_ref} @ ${hit.head_sha}] ${hit.path}:${hit.start_line}-${hit.end_line}${hit.symbol_name ? ` (${hit.symbol_name})` : ""}\n${hit.content}`,
      score, importance: 0.7, bank: `repo-${hit.repo_ref}`,
    }));
}

/** The authorized caller supplies target/project refs; both searches are
 * scoped in SQL. One statement gives both candidate lists the same snapshot. */
export async function recallRepoContext(refs: string[], prompt: string): Promise<Memory[]> {
  if (!prompt.trim()) return [];
  const distinct = [...new Set(refs.filter(Boolean))];
  const tokens = [...new Set(identifierText(prompt).match(/[\p{L}\p{N}_$./-]+/gu) ?? [])].slice(0, 80);
  if (!tokens.length || !distinct.length) return [];
  const tsquery = tokens.map((token) => `'${token.replace(/'/g, "''")}'`).join(" | ");
  let config: ReturnType<typeof repoEmbeddingConfig> = null;
  try { config = repoEmbeddingConfig(); } catch { /* keyword search survives bad config */ }
  const vector = config ? await embedRepoTexts(config, [prompt], 2500, "query").then((vectors) => vectors[0]).catch(() => null) : null;
  return (await Promise.all(distinct.map(async (ref) => {
    const rows = await query<Hit & { kind: string; rank: number }>(`WITH lexical AS (
        SELECT c.*, i.head_sha, (symbol_name = ANY($3::text[]) OR path = ANY($3::text[])) AS exact,
          ts_rank_cd(search_vector, to_tsquery('simple', $4)) AS rank
        FROM repo_context_chunks c JOIN repo_context_index i USING(repo_ref)
        WHERE c.repo_ref = $1 AND i.index_version = $2 AND (search_vector @@ to_tsquery('simple', $4)
          OR symbol_name = ANY($3::text[]) OR path = ANY($3::text[]))
        ORDER BY exact DESC, rank DESC, path, start_line LIMIT $5
      ), semantic AS (
        SELECT c.*, i.head_sha, (embedding <=> $6::vector) AS distance
        FROM repo_context_chunks c JOIN repo_context_index i USING(repo_ref)
        WHERE c.repo_ref = $1 AND i.index_version = $2 AND $6::vector IS NOT NULL AND embedding_key = $7
        ORDER BY distance, path, start_line LIMIT $5
      )
      SELECT repo_ref, head_sha, chunk_id, path, start_line, end_line, symbol_name, content, exact, rank, 'lexical' AS kind FROM lexical
      UNION ALL
      SELECT repo_ref, head_sha, chunk_id, path, start_line, end_line, symbol_name, content, false, -distance, 'semantic' AS kind FROM semantic`,
    [ref, INDEX_VERSION, tokens, tsquery, CANDIDATES, vector ? JSON.stringify(vector) : null, config?.key ?? null]);
    const lexical = rows.filter((row) => row.kind === "lexical").sort((a, b) => Number(b.exact) - Number(a.exact) || b.rank - a.rank);
    const semantic = rows.filter((row) => row.kind === "semantic").sort((a, b) => b.rank - a.rank);
    return fuseRepoHits(lexical, semantic);
  }))).flat();
}

export async function forgetRepoIndex(ref: string): Promise<void> {
  await transaction(async (tx) => {
    await tx.query(`DELETE FROM repo_context_jobs WHERE repo_ref = $1`, [ref]);
    await tx.query(`DELETE FROM repo_context_index WHERE repo_ref = $1`, [ref]);
  });
}
