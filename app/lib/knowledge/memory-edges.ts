import { query, transaction } from "../db/client";
import { memoryId, MemoryError, requireMemoryAccess } from "./memory-records";

export type EdgeInput =
  | { relation: "supports" | "contradicts"; memoryId: string }
  | { relation: "discussed_in"; messageId: string }
  | { relation: "implemented_by" | "mentions_file"; turnId: string; path?: string };

export async function addMemoryEdge(roomId: string, userId: string, fromId: string, input: EdgeInput) {
  memoryId(fromId);
  return transaction(async (tx) => {
    await requireMemoryAccess(tx, roomId, userId);
    const { rows: [source] } = await tx.query(`SELECT * FROM memory_records m WHERE id=$1 AND room_id=$2 AND memory_source_live(m) FOR UPDATE`, [fromId, roomId]);
    if (!source) throw new MemoryError("Memory is unavailable.", 404);
    let target: string | null = null, message: string | null = null, turn: string | null = null;
    let repo: string | null = null, sha: string | null = null, path: string | null = null;
    if (input.relation === "supports" || input.relation === "contradicts") {
      target = memoryId(input.memoryId);
      const { rows: [other] } = await tx.query(`SELECT id FROM memory_records m WHERE id=$1 AND room_id=$2 AND memory_source_live(m)`, [target, roomId]);
      if (!other || target === fromId) throw new MemoryError("Related memory is unavailable.", 404);
    } else if (input.relation === "discussed_in") {
      message = memoryId(input.messageId);
      const { rows: [other] } = await tx.query(`SELECT id FROM session_messages WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL`, [message, roomId]);
      if (!other) throw new MemoryError("Related message is unavailable.", 404);
    } else if (input.relation === "implemented_by" || input.relation === "mentions_file") {
      turn = memoryId(input.turnId);
      const { rows: [execution] } = await tx.query(`SELECT t.result,COALESCE(r.repo_id,r.session_id) AS repo_ref
        FROM agent_turns t JOIN agent_runs r ON r.id=t.run_id WHERE t.id=$1 AND r.session_id=$2
        AND t.status='completed' AND EXISTS (SELECT 1 FROM memory_records m WHERE m.source_turn_id=t.id
          AND m.parent_id IS NULL AND m.kind='episode' AND m.status='approved' AND memory_source_live(m))`, [turn, roomId]);
      if (!execution?.result?.headSha) throw new MemoryError("An approved code-changing turn in this room is required.", 409);
      repo = execution.repo_ref; sha = execution.result.headSha;
      if (input.path !== undefined) {
        if (typeof input.path !== "string" || !execution.result.changes?.some((file: { path: string }) => file.path === input.path)) throw new MemoryError("File is not part of this turn's changes.");
        path = input.path;
      }
      if (input.relation === "mentions_file" && !path) throw new MemoryError("A changed file path is required.");
    } else throw new MemoryError("Unknown relationship. Supersession is created by approving a replacement.");
    await tx.query(`INSERT INTO memory_edges(from_id,relation,to_memory_id,to_message_id,to_turn_id,repo_ref,commit_sha,path,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [fromId, input.relation, target, message, turn, repo, sha, path, userId]);
  });
}

/** Bounded, cycle-safe traversal. Every node is authorized before expansion;
 * edge endpoints never act as a way around room visibility. */
export async function memoryGraph(roomId: string, userId: string, rootId: string, hops = 3) {
  memoryId(rootId);
  if (!Number.isInteger(hops) || hops < 0 || hops > 4) throw new MemoryError("Graph depth must be between 0 and 4.");
  const nodes = await query(`WITH RECURSIVE visible AS (
      SELECT m.* FROM memory_records m WHERE room_id=$1 AND room_access_role(room_id,$2) IS NOT NULL AND memory_source_live(m)
    ), walk(id,depth) AS (
      SELECT id,0 FROM visible WHERE id=$3
      UNION
      SELECT m.id,w.depth+1 FROM walk w JOIN memory_edges e ON e.from_id=w.id OR e.to_memory_id=w.id
        JOIN visible m ON m.id=CASE WHEN e.from_id=w.id THEN e.to_memory_id ELSE e.from_id END
      WHERE w.depth<$4
    ) SELECT * FROM visible WHERE id IN (SELECT id FROM walk) ORDER BY (id=$3) DESC,stated_at,id LIMIT 100`, [roomId, userId, rootId, hops]);
  if (!nodes.some((row) => row.id === rootId)) throw new MemoryError("Memory is unavailable.", 404);
  const ids = nodes.map((node) => node.id);
  const edges = await query(`SELECT e.* FROM memory_edges e JOIN memory_records m ON m.id=e.from_id
    WHERE e.from_id=ANY($1::uuid[]) AND room_access_role(m.room_id,$2) IS NOT NULL AND memory_source_live(m)
      AND (e.to_memory_id IS NULL OR e.to_memory_id=ANY($1::uuid[]))
      AND (e.to_message_id IS NULL OR EXISTS (SELECT 1 FROM session_messages s WHERE s.id=e.to_message_id
        AND s.deleted_at IS NULL AND room_access_role(s.session_id,$2) IS NOT NULL))
      AND (e.to_turn_id IS NULL OR EXISTS (SELECT 1 FROM agent_turns t JOIN agent_runs r ON r.id=t.run_id
        WHERE t.id=e.to_turn_id AND room_access_role(r.session_id,$2) IS NOT NULL)) ORDER BY e.created_at,e.id LIMIT 300`, [ids, userId]);
  const events = await query(`SELECT e.* FROM memory_events e JOIN memory_records m ON m.id=e.memory_id
    WHERE e.memory_id=ANY($1::uuid[]) AND room_access_role(m.room_id,$2) IS NOT NULL AND memory_source_live(m)
    ORDER BY e.created_at,e.id LIMIT 500`, [ids, userId]);
  const jobs = await query(`SELECT j.memory_id,j.operation,j.attempts,j.retry_at,j.last_error FROM memory_jobs j
    JOIN memory_records m ON m.id=j.memory_id WHERE j.memory_id=ANY($1::uuid[])
      AND room_access_role(m.room_id,$2) IN ('owner','editor') AND memory_source_live(m)`, [ids, userId]);
  const sources = await query(`SELECT DISTINCT m.id AS memory_id, COALESCE(s.body,a.body,m.evidence_quote) AS body,
      u.display_name AS author FROM memory_records m
    LEFT JOIN session_messages s ON s.id=m.source_message_id
    LEFT JOIN agent_run_messages a ON a.id=m.source_agent_message_id
    LEFT JOIN users u ON u.id=m.stated_by
    WHERE m.id=ANY($1::uuid[]) AND room_access_role(m.room_id,$2) IS NOT NULL AND memory_source_live(m)`, [ids,userId]);
  return { nodes, edges, events, jobs, sources };
}
