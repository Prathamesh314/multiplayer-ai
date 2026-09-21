/*
 * The knowledge layer's front door: one call that routes a prompt, materializes
 * the project's knowledge graph, and recalls from the right banks.
 *
 * The derived project/room/run tree chooses sources by scope and recency.
 * Repository chunks and conversation records are retrieved independently.
 * Memory candidates from the sidecar and Postgres keyword search are hydrated
 * from authoritative records, with current status, sources, and access checked
 * again before they can reach a prompt. No raw or canonical sidecar text is used.
 *
 * Access is never widened here. The graph is built from `visibleRoomIds` — the
 * same gate the FTS reference layer uses — so one team's memory cannot surface
 * in another's prompt; the repo node is project-scoped, and every caller of
 * this function already holds write access to a room of the project.
 */

import { query } from "../db/client";
import { visibleRoomIds } from "../project/store";
import { recallMemories } from "./memory-retrieval";
import {
  assembleKnowledgeGraph,
  repoNode,
  selectRoomBanks,
} from "./graph";
import type { KnowledgeNode, RoomInput } from "./graph";
import { routeQuery } from "./router";
import type { ContextRoute } from "./router";
import { ensureRepoIndexed, indexedRepoSha, recallRepoContext } from "./repo-context";
import { buildRoomChatContext, emptyRoomChat, type RoomChatContext } from "./room-chat";

/**
 * Cap on how many room banks one retrieval fans out over. Recall issues one
 * backend call per bank, so an unbounded project would mean an unbounded number
 * of calls on the run's critical path. When the cap truncates, the caller is
 * told (`truncatedRooms`) rather than silently narrowing.
 */
const MAX_BANKS = 8;
/** Run nodes attached to the graph — structure and recency, not vectors. */
const RUN_NODE_CAP = 200;

export type KnowledgeContext = {
  /** Human project-room discussions, kept distinct from distilled AI facts. */
  chatText: string | null;
  chatRecalled: number;
  chatSources: RoomChatContext["sources"];
  /** Approved, source-checked records; sidecar text never reaches the prompt. */
  memoryText: string | null;
  /** The <repo-context> block: indexed code-context hits, or null. */
  repoText: string | null;
  recalled: number;
  repoRecalled: number;
  truncatedRooms: number;
  /** Which sources the router chose, and why — for notices and telemetry. */
  route: ContextRoute;
};

/**
 * Materialize the caller-visible knowledge graph for a project. Exported for
 * future surfaces (a graph inspector, retention tooling); retrieval below uses
 * it directly.
 */
export async function loadKnowledgeGraph(input: {
  /** Null for a personal room: the graph is just that room, no project fan-out. */
  projectId: string | null;
  userId: string;
  currentSessionId: string;
}): Promise<KnowledgeNode> {
  const visible = input.projectId
    ? await visibleRoomIds(input.projectId, input.userId)
    : new Set<string>();
  // The caller's own room is always part of the graph, mirroring the flat
  // layer's contract: a chat can always recall its own memory.
  const ids = [...new Set([input.currentSessionId, ...visible])];

  const [rooms, activity, runs, repoSha] = await Promise.all([
    query<{ id: string; name: string }>(
      `SELECT id, name FROM sessions WHERE id = ANY($1)`,
      [ids],
    ),
    query<{ session_id: string; last_run_at: Date }>(
      `SELECT session_id, MAX(created_at) AS last_run_at FROM (
         SELECT session_id, created_at FROM agent_runs WHERE session_id = ANY($1)
         UNION ALL SELECT room_id AS session_id, stated_at AS created_at FROM memory_records WHERE room_id = ANY($1)
       ) activity GROUP BY session_id`,
      [ids],
    ),
    query<{ id: string; session_id: string; title: string | null; created_at: Date }>(
      `SELECT id, session_id, title, created_at
         FROM agent_runs WHERE session_id = ANY($1)
        ORDER BY created_at DESC LIMIT $2`,
      [ids, RUN_NODE_CAP],
    ),
    input.projectId ? indexedRepoSha(input.projectId) : Promise.resolve(null),
  ]);

  const activityByRoom = new Map(
    activity.map((row) => [row.session_id, row.last_run_at.getTime()]),
  );
  const runsByRoom = new Map<string, NonNullable<RoomInput["runs"]>>();
  for (const run of runs) {
    const list = runsByRoom.get(run.session_id) ?? [];
    list.push({ id: run.id, title: run.title, createdAt: run.created_at.getTime() });
    runsByRoom.set(run.session_id, list);
  }

  return assembleKnowledgeGraph({
    projectId: input.projectId ?? `personal:${input.currentSessionId}`,
    rooms: rooms.map((room) => ({
      id: room.id,
      name: room.name,
      lastActivity: activityByRoom.get(room.id) ?? 0,
      runs: runsByRoom.get(room.id) ?? [],
    })),
    repoSha,
  });
}

type KnowledgeInput = {
  /** Null for a personal room — knowledge then spans just that room + its repo. */
  projectId: string | null;
  userId: string;
  currentSessionId: string;
  /** The room repo the chat targets; null/omitted = the room's own fork. */
  repoId?: string | null;
  prompt: string;
};

/** Route once per turn and recall human chat alongside the optional AI/repo
 * banks. Source failures are isolated and do not prevent the run from starting. */
export async function buildKnowledgeContext(input: KnowledgeInput): Promise<KnowledgeContext> {
  const route = routeQuery(input.prompt);
  // The SQL branch is independent of the optional vector sidecar. A failed
  // source must not discard useful context returned by the other branches.
  const [banks, chat] = await Promise.all([
    buildBankContext(input).catch((cause) => {
      console.warn("Knowledge bank recall failed", cause);
      return { memoryText: null, repoText: null, recalled: 0, repoRecalled: 0, truncatedRooms: 0, route };
    }),
    route.chat
      ? buildRoomChatContext(input).catch((cause) => {
          console.warn("Project room chat recall failed", cause);
          return emptyRoomChat();
        })
      : Promise.resolve(emptyRoomChat()),
  ]);
  return { ...banks, chatText: chat.text, chatRecalled: chat.recalled, chatSources: chat.sources };
}

async function buildBankContext(input: KnowledgeInput): Promise<Omit<KnowledgeContext, "chatText" | "chatRecalled" | "chatSources">> {
  const route = routeQuery(input.prompt);
  if (!input.prompt.trim()) {
    return { memoryText: null, repoText: null, recalled: 0, repoRecalled: 0, truncatedRooms: 0, route };
  }

  const graph = await loadKnowledgeGraph(input);
  const { rooms, truncatedRooms } = selectRoomBanks(graph, input.currentSessionId, {
    scope: route.graphScope,
    maxBanks: MAX_BANKS,
  });

  // Keep the canonical-main bank warm even on turns that don't recall from
  // it — main is approved by definition, so the read path may index it. The
  // chat's own repo (fork or import) is deliberately NOT kicked here: its
  // context updates only at approval points (publish / completion).
  if (input.projectId && (repoNode(graph) === null || route.repo)) {
    void ensureRepoIndexed(input.projectId);
  }

  // The repo the AI is about to change comes first; the project's canonical
  // main rides along as the shared frame of reference.
  const targetRepoRef = input.repoId ?? input.currentSessionId;

  // Independent sources: a sidecar outage cannot discard SQL-backed evidence.
  const [memories, repoHits] = await Promise.all([
    recallMemories({ roomIds: rooms.map((room) => room.id), userId: input.userId, prompt: input.prompt })
      .catch((cause) => { console.warn("Memory recall failed", cause); return { text: null, records: [] }; }),
    route.repo
      ? recallRepoContext(
          input.projectId ? [targetRepoRef, input.projectId] : [targetRepoRef],
          input.prompt,
        ).catch(() => [])
      : Promise.resolve([]),
  ]);

  const repoLines = repoHits
    .map((hit) => hit.content.trim())
    .filter(Boolean)
    .map((content) => `- ${content}`);

  return {
    memoryText: memories.text,
    repoText: repoLines.length > 0
      ? `Indexed source excerpts for orientation. Verify against the isolated checkout before editing; the indexed commit may differ from the working commit.\n${repoLines.join("\n")}`
      : null,
    recalled: memories.records.length,
    repoRecalled: repoLines.length,
    truncatedRooms,
    route,
  };
}
