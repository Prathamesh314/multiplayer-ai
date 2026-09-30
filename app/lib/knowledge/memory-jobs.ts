import { projectRepositoryForRoom } from "../project/repositories";
import { randomUUID } from "node:crypto";
import { query, queryOne, transaction } from "../db/client";
import { memoryEnabled, remember } from "../ai/mnemosyne";
import { sharedRepositoryHeadSha, repoContainsCommit } from "../session/repo";
import { isUuid } from "../ai/turns";
import { enqueueMemoryJob, extractedKey, insertDerivedMemory, recordMemoryEvent, type MemoryRecord } from "./memory-records";
import { extractClaims, extractionEnabled, validateClaims } from "./memory-extraction";
import { roomBank } from "./graph";

/** Dedicated banks: legacy free-form summaries cannot impersonate typed rows. */
export const recordBank = roomBank;
export const indexContent = (memory: Pick<MemoryRecord, "id" | "revision" | "text">) =>
  `memory-record:${memory.id}:${memory.revision}\n${memory.text}`;
export function indexedIdentity(content: string): { id: string; revision: number } | null {
  const match = /^memory-record:([0-9a-f-]{36}):([1-9][0-9]*)\n/i.exec(content);
  return match && isUuid(match[1]) && Number(match[2]) <= 2147483647 ? { id: match[1], revision: Number(match[2]) } : null;
}

/** Publication and approval are one DB transaction, including the index job.
 * Candidates remain proposals; publishing a commit approves the episode, not
 * every factual inference an extraction model may have made about it. */
async function markPublished(id: string, actorId: string | null) {
  return transaction(async (tx) => {
    const { rows: [m] } = await tx.query<MemoryRecord>(`SELECT * FROM memory_records WHERE id=$1 FOR UPDATE`, [id]);
    if (!m || m.status !== "proposed" || !m.publish_gated || m.kind !== "episode") return false;
    const { rows: [approved] } = await tx.query<MemoryRecord>(`UPDATE memory_records SET status='approved',published_at=now(),
      approved_at=now(),approved_by=$2,valid_from=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [id, actorId]);
    await tx.query(`UPDATE memory_records SET published_at=now(),updated_at=now() WHERE parent_id=$1 AND published_at IS NULL`, [id]);
    await recordMemoryEvent(tx, id, "proposed", "approved", actorId, "Source commit verified in project main");
    await enqueueMemoryJob(tx, approved, "index");
    await tx.query(`DELETE FROM memory_jobs WHERE memory_id=$1 AND operation='publish'`, [id]);
    return true;
  });
}

/** Called after Publish and also by durable per-episode jobs. An immutable
 * ancestry check excludes code completed concurrently after the publication. */
export async function approvePublishedMemories(roomId: string, sha: string, actorId: string, repoRef?: string): Promise<number> {
  const records = await query<MemoryRecord>(`SELECT * FROM memory_records WHERE room_id=$1
    AND kind='episode' AND status='proposed' AND publish_gated AND commit_sha IS NOT NULL`, [roomId]);
  let approved = 0;
  for (const memory of records) {
    if (repoRef && memory.repo_ref !== repoRef) continue;
    const repositoryId = await projectRepositoryForRoom(roomId, memory.repo_ref === roomId ? null : memory.repo_ref);
    if (repositoryId && await repoContainsCommit(repositoryId, memory.commit_sha!, sha)) {
      if (await markPublished(memory.id, actorId)) approved++;
    }
  }
  return approved;
}

type Job = { memory_id: string; operation: "index" | "extract" | "publish"; revision: number; attempts: number; lease_id: string };
export type MemoryJobDependencies = {
  index?: (memory: MemoryRecord) => Promise<boolean>;
  extract?: typeof extractClaims;
  published?: (memory: MemoryRecord) => Promise<boolean>;
};

/** Leased outbox: no network operation holds a database transaction open.
 * Delivery is at-least-once; stable record IDs make duplicate hits harmless.
 * A crashed worker's job becomes claimable again after its lease expires. */
export async function processMemoryJob(deps: MemoryJobDependencies = {}): Promise<boolean> {
  const operations = ["publish", ...(memoryEnabled() || deps.index ? ["index"] : []), ...(extractionEnabled() || deps.extract ? ["extract"] : [])];
  const token = randomUUID();
  const job = await queryOne<Job>(`UPDATE memory_jobs SET lease_id=$1,lease_until=now()+interval '2 minutes',attempts=attempts+1
    WHERE (memory_id,operation)=(SELECT memory_id,operation FROM memory_jobs
      WHERE operation=ANY($2::text[]) AND retry_at<=now() AND (lease_until IS NULL OR lease_until<now())
      ORDER BY retry_at,memory_id,operation LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`, [token, operations]);
  if (!job) return false;
  try {
    const memory = await queryOne<MemoryRecord>(`SELECT m.* FROM memory_records m JOIN sessions s ON s.id=m.room_id
      WHERE m.id=$1 AND memory_source_live(m) AND s.deleted_at IS NULL
        AND m.org_id IS NOT DISTINCT FROM s.org_id AND m.project_id IS NOT DISTINCT FROM s.project_id`, [job.memory_id]);
    if (!memory || !["proposed", "approved"].includes(memory.status)) {
      await finishJob(job);
      return true;
    }
    if (job.operation === "publish") {
      const published = deps.published ?? (async (m: MemoryRecord) => {
        const repositoryId = await projectRepositoryForRoom(m.room_id, m.repo_ref === m.room_id ? null : m.repo_ref);
        const head = repositoryId ? await sharedRepositoryHeadSha(repositoryId) : null;
        return !!(head && repositoryId && m.commit_sha && await repoContainsCommit(repositoryId, m.commit_sha, head));
      });
      if (!await published(memory)) throw new Error("Waiting for source commit to be published");
      await markPublished(memory.id, null);
      await finishJob(job);
    } else if (job.operation === "index") {
      if (memory.status === "approved") {
        const index = deps.index ?? ((m: MemoryRecord) => remember({ bank: recordBank(m.room_id), content: indexContent(m), importance: m.kind === "episode" ? 0.4 : 0.7, channelId: m.room_id, source: "memory-record", timeoutMs: 30_000 }));
        if (!await index(memory)) throw new Error("Semantic index did not acknowledge the memory");
      }
      await finishJob(job);
    } else {
      const claims = validateClaims({ memories: await (deps.extract ?? extractClaims)(memory) }, memory.text);
      await transaction(async (tx) => {
        const { rows: [live] } = await tx.query<MemoryRecord>(`SELECT m.* FROM memory_records m
          WHERE m.id=$1 AND m.status IN ('proposed','approved') AND memory_source_live(m) FOR UPDATE`, [memory.id]);
        const { rows: [lease] } = await tx.query(`SELECT 1 FROM memory_jobs WHERE memory_id=$1 AND operation='extract'
          AND lease_id=$2 AND lease_until>now() FOR UPDATE`, [memory.id, token]);
        if (!lease) return;
        if (live) for (const claim of claims) {
          await insertDerivedMemory(tx, live, claim, extractedKey(live.id, claim.kind, claim.text), null);
        }
        await tx.query(`DELETE FROM memory_jobs WHERE memory_id=$1 AND operation='extract' AND lease_id=$2`, [memory.id, token]);
      });
    }
  } catch (cause) {
    const seconds = Math.min(3600, 15 * 2 ** Math.min(job.attempts, 8));
    await query(`UPDATE memory_jobs SET lease_id=NULL,lease_until=NULL,retry_at=now()+$3*interval '1 second',last_error=$4
      WHERE memory_id=$1 AND operation=$2 AND lease_id=$5`,
    [job.memory_id, job.operation, seconds, cause instanceof Error ? cause.message.slice(0, 500) : "Memory job failed", token]);
  }
  return true;
}

async function finishJob(job: Job) {
  // A concurrent approval can replace the job and clear its lease. The old
  // worker must never acknowledge that newer revision's pending delivery.
  await query(`DELETE FROM memory_jobs WHERE memory_id=$1 AND operation=$2 AND lease_id=$3`, [job.memory_id, job.operation, job.lease_id]);
}
