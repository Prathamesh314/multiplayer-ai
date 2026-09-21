import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "../db/client";
import { isUuid } from "../ai/turns";

export type MemoryKind = "fact" | "episode" | "procedure";
export type MemoryStatus = "proposed" | "approved" | "superseded" | "retracted";
export type MemoryRecord = {
  id: string; room_id: string; org_id: string | null; project_id: string | null;
  kind: MemoryKind; text: string; status: MemoryStatus; revision: number;
  stated_by: string | null; speaker: "user" | "agent" | "mixed"; stated_at: Date;
  valid_from: Date; valid_to: Date | null; source_message_id: string | null;
  source_agent_message_id: string | null; source_run_id: string | null; source_turn_id: string | null;
  source_hash: string | null; evidence_quote: string | null; repo_ref: string | null;
  commit_sha: string | null; parent_id: string | null; supersedes: string | null;
  publish_gated: boolean; published_at: Date | null; approved_at: Date | null;
};
export class MemoryError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export const memoryId = (value: unknown): string => {
  if (!isUuid(value)) throw new MemoryError("Invalid memory/source ID.");
  return value;
};
export const memoryText = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim() || value.length > 20000) throw new MemoryError("Memory text must contain 1–20,000 characters.");
  return value.trim();
};

export async function requireMemoryAccess(tx: PoolClient, roomId: string, userId: string, write = true) {
  const { rows: [row] } = await tx.query(`SELECT room_access_role($1, $2) AS role`, [roomId, userId]);
  if (!row?.role || (write && !["owner", "editor"].includes(row.role))) throw new MemoryError("You do not have access to these memories.", 403);
}

export async function enqueueMemoryJob(tx: PoolClient, memory: Pick<MemoryRecord, "id" | "revision">, operation: "index" | "extract" | "publish") {
  await tx.query(`INSERT INTO memory_jobs(memory_id, operation, revision) VALUES ($1, $2, $3)
    ON CONFLICT (memory_id, operation) DO UPDATE SET revision = EXCLUDED.revision,
      retry_at = now(), attempts = 0, last_error = NULL, lease_id = NULL, lease_until = NULL`,
  [memory.id, operation, memory.revision]);
}

export async function recordMemoryEvent(tx: PoolClient, id: string, from: MemoryStatus | null, to: MemoryStatus, actor: string | null, reason: string) {
  await tx.query(`INSERT INTO memory_events(memory_id, from_status, to_status, actor_id, reason) VALUES ($1,$2,$3,$4,$5)`, [id, from, to, actor, reason]);
}

/** Called in the SAME transaction as the transcript and completed turn. No
 * network calls here: failure rolls back completion so reconciliation retries. */
export async function recordExchange(tx: PoolClient, input: {
  sessionId: string; runId: string; turnId: string; prompt: string; reply: string;
  agentMessageId: string | null; commitSha: string | null; repoRef: string;
}) {
  const { rows: [source] } = await tx.query(`SELECT s.project_id, r.repo_id, t.driver_user_id, t.created_at
    FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id JOIN sessions s ON s.id = r.session_id
    WHERE t.id = $1 AND r.id = $2 AND s.id = $3 AND t.status = 'completed'`, [input.turnId, input.runId, input.sessionId]);
  if (!source) throw new MemoryError("A completed source turn is required.");
  const text = [`User: ${input.prompt.trim()}`, `Agent: ${input.reply.trim()}`].join("\n").slice(0, 20000);
  const gated = !!(input.commitSha && source.project_id && !source.repo_id);
  const { rows: [memory] } = await tx.query<MemoryRecord>(`INSERT INTO memory_records
    (room_id, kind, text, status, stated_by, speaker, stated_at, source_run_id, source_turn_id,
     source_agent_message_id, repo_ref, commit_sha, publish_gated, dedupe_key, approved_at)
    VALUES ($1,'episode',$2,$3,$4,'mixed',$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $11 THEN NULL ELSE now() END)
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
  [input.sessionId, text, gated ? "proposed" : "approved", source.driver_user_id, source.created_at,
    input.runId, input.turnId, input.agentMessageId, input.repoRef, input.commitSha, gated, `turn:${input.turnId}`]);
  if (!memory) return;
  await recordMemoryEvent(tx, memory.id, null, memory.status, source.driver_user_id, gated ? "Waiting for project publication" : "Completed exchange (historical evidence, not an endorsed factual claim)");
  if (memory.status === "approved") await enqueueMemoryJob(tx, memory, "index");
  if (gated) await enqueueMemoryJob(tx, memory, "publish");
  await enqueueMemoryJob(tx, memory, "extract");
  if (input.commitSha) {
    await tx.query(`INSERT INTO memory_edges(from_id, relation, to_turn_id, repo_ref, commit_sha)
      VALUES ($1,'implemented_by',$2,$3,$4) ON CONFLICT DO NOTHING`, [memory.id, input.turnId, input.repoRef, input.commitSha]);
    await tx.query(`INSERT INTO memory_edges(from_id, relation, to_turn_id, repo_ref, commit_sha, path)
      SELECT $1,'mentions_file',t.id,$3,$4,c->>'path' FROM agent_turns t,
        jsonb_array_elements(t.result->'changes') c WHERE t.id = $2 ON CONFLICT DO NOTHING`,
    [memory.id, input.turnId, input.repoRef, input.commitSha]);
  }
}

export type CreateMemory = { kind: MemoryKind; text: string; sourceMessageId?: string; sourceMemoryId?: string; evidenceQuote?: string };

/** Multiple claims may point to one exchange. Extracted claims are always
 * proposals; an extraction model cannot approve or supersede a decision. */
export async function insertDerivedMemory(tx: PoolClient, source: MemoryRecord, input: {
  kind: MemoryKind; text: string; evidenceQuote?: string;
}, dedupeKey: string, actor: string | null) {
  const text = memoryText(input.text);
  if (!["fact", "episode", "procedure"].includes(input.kind)) throw new MemoryError("Unknown memory kind.");
  if (input.evidenceQuote && !source.text.includes(input.evidenceQuote)) throw new MemoryError("The evidence quote does not appear in the source.");
  const { rows: [row] } = await tx.query<MemoryRecord>(`INSERT INTO memory_records
    (room_id, kind, text, stated_by, speaker, stated_at, source_message_id, source_agent_message_id,
     source_run_id, source_turn_id, repo_ref, commit_sha, parent_id, publish_gated, published_at, evidence_quote, dedupe_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (dedupe_key) DO NOTHING RETURNING *`,
  [source.room_id, input.kind, text, source.stated_by, source.speaker, source.stated_at,
    source.source_message_id, source.source_agent_message_id, source.source_run_id, source.source_turn_id,
    source.repo_ref, source.commit_sha, source.id, source.publish_gated, source.published_at,
    input.evidenceQuote ?? null, dedupeKey]);
  if (row) await recordMemoryEvent(tx, row.id, null, "proposed", actor, "Claim derived from source; requires review");
  return row;
}

export async function createMemory(roomId: string, userId: string, input: CreateMemory): Promise<MemoryRecord> {
  memoryText(input.text);
  if (!["fact", "episode", "procedure"].includes(input.kind)) throw new MemoryError("Unknown memory kind.");
  if (Number(!!input.sourceMessageId) + Number(!!input.sourceMemoryId) !== 1) throw new MemoryError("Choose exactly one source message or source episode.");
  return transaction(async (tx) => {
    await requireMemoryAccess(tx, roomId, userId);
    if (input.sourceMemoryId) {
      const { rows: [source] } = await tx.query<MemoryRecord>(`SELECT m.* FROM memory_records m
        WHERE m.id=$1 AND m.room_id=$2 AND m.kind='episode' AND m.status IN ('proposed','approved')
          AND memory_source_live(m) FOR UPDATE`, [memoryId(input.sourceMemoryId), roomId]);
      if (!source) throw new MemoryError("Source episode is unavailable.", 404);
      return (await insertDerivedMemory(tx, source, input, `manual:${randomUUID()}`, userId))!;
    }
    const { rows: [message] } = await tx.query(`SELECT * FROM session_messages
      WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL FOR SHARE`, [memoryId(input.sourceMessageId), roomId]);
    if (!message) throw new MemoryError("Source message is unavailable.", 404);
    if (input.evidenceQuote && !message.body.includes(input.evidenceQuote)) throw new MemoryError("The evidence quote does not appear in the source.");
    const { rows: [row] } = await tx.query<MemoryRecord>(`INSERT INTO memory_records
      (room_id, kind, text, source_message_id, stated_at, stated_by, evidence_quote, dedupe_key)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [roomId, input.kind, input.text.trim(), message.id, message.created_at, message.user_id, input.evidenceQuote ?? null, `manual:${randomUUID()}`]);
    await tx.query(`INSERT INTO memory_edges(from_id,relation,to_message_id,created_by) VALUES ($1,'discussed_in',$2,$3)`, [row.id, message.id, userId]);
    await recordMemoryEvent(tx, row.id, null, "proposed", userId, "Created from source message; requires review");
    return row;
  });
}

export async function transitionMemory(roomId: string, userId: string, id: string, input: {
  status: "approved" | "retracted"; revision: number; supersedes?: string;
}): Promise<MemoryRecord> {
  memoryId(id);
  if (!["approved", "retracted"].includes(input.status) || !Number.isInteger(input.revision)) throw new MemoryError("Provide status and expected revision.");
  if (input.supersedes) memoryId(input.supersedes);
  return transaction(async (tx) => {
    await requireMemoryAccess(tx, roomId, userId);
    // Lock in a stable order so concurrent replacements cannot deadlock.
    const { rows } = await tx.query<MemoryRecord>(`SELECT * FROM memory_records WHERE room_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [roomId, [id, ...(input.supersedes ? [input.supersedes] : [])]]);
    const memory = rows.find((row) => row.id === id);
    if (!memory) throw new MemoryError("Memory is unavailable.", 404);
    if (memory.revision !== input.revision) throw new MemoryError("Memory changed. Refresh before editing.", 409);
    if (!['proposed', 'approved'].includes(memory.status) || memory.status === input.status) throw new MemoryError("This lifecycle transition is not allowed.", 409);
    if (input.status === "approved") {
      const { rows: [live] } = await tx.query(`SELECT memory_source_live(m) AS live FROM memory_records m WHERE id=$1`, [id]);
      if (!live?.live) throw new MemoryError("Source was edited or is unavailable; create a new memory from current evidence.", 409);
      if (memory.publish_gated && !memory.published_at) throw new MemoryError("Publish the source code before approving this memory.", 409);
      if (memory.parent_id) {
        const { rows: [parent] } = await tx.query(`SELECT status FROM memory_records WHERE id=$1`, [memory.parent_id]);
        if (parent?.status !== "approved") throw new MemoryError("Approve the source episode first.", 409);
      }
    }
    if (input.supersedes) {
      const old = rows.find((row) => row.id === input.supersedes);
      if (input.status !== "approved" || !old || old.id === id || old.status !== "approved" || old.kind !== memory.kind || memory.kind === "episode") {
        throw new MemoryError("A replacement must supersede an approved fact or procedure of the same kind in this room.", 409);
      }
      await tx.query(`UPDATE memory_records SET status='superseded',valid_to=now(),revision=revision+1,updated_at=now() WHERE id=$1`, [old.id]);
      await recordMemoryEvent(tx, old.id, old.status, "superseded", userId, `Replaced by ${id}`);
      await tx.query(`DELETE FROM memory_jobs WHERE memory_id=$1`, [old.id]);
      await tx.query(`INSERT INTO memory_edges(from_id,relation,to_memory_id,created_by) VALUES ($1,'supersedes',$2,$3)`, [id, old.id, userId]);
    }
    const { rows: [updated] } = await tx.query<MemoryRecord>(`UPDATE memory_records SET status=$2, revision=revision+1, updated_at=now(),
      supersedes=COALESCE($3,supersedes), valid_from=CASE WHEN $2='approved' THEN now() ELSE valid_from END,
      valid_to=CASE WHEN $2='retracted' THEN now() ELSE NULL END,
      approved_by=CASE WHEN $2='approved' THEN $4 ELSE approved_by END,
      approved_at=CASE WHEN $2='approved' THEN now() ELSE approved_at END WHERE id=$1 RETURNING *`, [id, input.status, input.supersedes ?? null, userId]);
    await recordMemoryEvent(tx, id, memory.status, updated.status, userId, input.status === "approved" ? "Explicit editor approval" : "Explicit editor retraction");
    if (updated.status === "approved") await enqueueMemoryJob(tx, updated, "index");
    else await tx.query(`DELETE FROM memory_jobs WHERE memory_id=$1`, [id]);
    return updated;
  });
}

/** List/history APIs also recheck current permissions and source revisions. */
export async function listMemories(roomId: string, userId: string, options: { status?: MemoryStatus; before?: string; limit?: number } = {}) {
  if (options.status && !["proposed", "approved", "superseded", "retracted"].includes(options.status)) throw new MemoryError("Unknown memory status.");
  if (options.before) memoryId(options.before);
  return query<MemoryRecord>(`SELECT m.* FROM memory_records m WHERE room_id=$1 AND room_access_role(room_id,$2) IS NOT NULL
    AND memory_source_live(m) AND ($3::text IS NULL OR status=$3)
    AND ($4::uuid IS NULL OR (created_at,id) < (SELECT created_at,id FROM memory_records WHERE id=$4 AND room_id=$1))
    ORDER BY created_at DESC,id DESC LIMIT $5`, [roomId, userId, options.status ?? null, options.before ?? null, Math.min(100, Math.max(1, options.limit ?? 50))]);
}

export const extractedKey = (parentId: string, kind: string, text: string) =>
  `extracted:${parentId}:${createHash("sha256").update(`${kind}:${text.trim()}`).digest("hex")}`;
