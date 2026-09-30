import { createHash } from "node:crypto";
import { query, transaction } from "../db/client";
import { readActivityObject, storeActivityObject } from "../storage/blobs";
import type { AiRunEvent } from "../ai/run-events";

export function sharedActivity(events: AiRunEvent[]): AiRunEvent[] {
  return events.filter(event => ["out", "act", "err", "notice"].includes(event.t));
}
export function validateActivity(events: unknown): events is AiRunEvent[] {
  return Array.isArray(events) && events.length <= 500 && events.every(event => event && (
    ["out", "act", "err", "think"].includes(event.t) ? typeof event.d === "string" && event.d.length <= 65536 :
    event.t === "notice" ? typeof event.message === "string" && event.message.length <= 65536 :
    event.t === "start" && typeof event.agent === "string" && typeof event.cwd === "string" && typeof event.runId === "string"
  ));
}
/** Sequence gaps/conflicting retries are rejected, never silently acknowledged. */
export async function persistActivity(turnId: string, sequence: number, events: AiRunEvent[]): Promise<boolean> {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 20000) throw new Error("Invalid activity sequence.");
  const text = JSON.stringify(sharedActivity(events));
  const hash = createHash("sha256").update(text).digest("hex");
  return transaction(async tx => {
    await tx.query(`SELECT id FROM agent_turns WHERE id = $1 FOR UPDATE`, [turnId]);
    const { rows: [existing] } = await tx.query(`SELECT content_hash FROM run_activity_batches WHERE turn_id = $1 AND sequence = $2`, [turnId, sequence]);
    if (existing) { if (existing.content_hash !== hash) throw new Error("Activity retry differs from acknowledged content."); return false; }
    const { rows: [state] } = await tx.query(`SELECT COALESCE(MAX(sequence), 0)::int AS last, COALESCE(SUM(bytes), 0)::int AS bytes FROM run_activity_batches WHERE turn_id = $1`, [turnId]);
    if (sequence !== state.last + 1) throw new Error(`Expected activity sequence ${state.last + 1}.`);
    if (state.bytes + Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Turn activity exceeds its 8 MB limit.");
    const object = await storeActivityObject(turnId, text);
    await tx.query(`INSERT INTO run_activity_batches(turn_id, sequence, object_key, content_hash, bytes) VALUES ($1,$2,$3,$4,$5)`, [turnId, sequence, object.key, object.hash, object.bytes]);
    return true;
  });
}
export async function activityPage(turnId: string, after: number) {
  const rows = await query<{ sequence: number; object_key: string; content_hash: string; created_at: string }>(`SELECT sequence, object_key, content_hash, created_at FROM run_activity_batches WHERE turn_id = $1 AND sequence > $2 ORDER BY sequence LIMIT 8`, [turnId, after]);
  const batches = [];
  for (const row of rows) batches.push({ sequence: row.sequence, syncedAt: row.created_at, events: JSON.parse(await readActivityObject(row.object_key, row.content_hash)) as AiRunEvent[] });
  return batches;
}
