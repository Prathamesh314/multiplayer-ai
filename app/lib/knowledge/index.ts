/*
 * The knowledge layer's front door: one call that routes a prompt, materializes
 * the project's knowledge graph, and recalls from the right banks.
 *
 * This subsumes the flat "shared memory" fan-out that used to live in
 * app/lib/ai/shared-memory.ts (which keeps the *write* path: ingest and
 * consolidation). What changed with the graph:
 *
 * - Room order is principled: the caller's own room first, then rooms by real
 *   recency (latest run), where the flat version took Set iteration order.
 * - Rooms that never ran anything are skipped instead of spending a recall
 *   call on an empty bank.
 * - The router (router.ts) decides per prompt whether to touch the repo bank,
 *   the conversation banks project-wide, or only the caller's own room.
 * - All recalls — episodic banks, canonical facts, repo context — go out in
 *   one parallel wave, where the flat version serialized canonical after
 *   episodic.
 *
 * Access is never widened here. The graph is built from `visibleRoomIds` — the
 * same gate the FTS reference layer uses — so one team's memory cannot surface
 * in another's prompt; the repo node is project-scoped, and every caller of
 * this function already holds write access to a room of the project.
 */

import { query } from "../db/client";
import { visibleRoomIds } from "../project/store";
import { memoryEnabled, recall, recallCanonical } from "../ai/mnemosyne";
import {
  assembleKnowledgeGraph,
  mergeRecalled,
  repoNode,
  roomBank,
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
/** Memories kept per bank before the cross-bank merge. */
const PER_BANK = 4;
/** Memories kept after merging every bank's hits. */
const TOTAL = 8;
/** One memory can't run away with the prompt budget. */
const MAX_MEMORY_CHARS = 800;
/** Durable canonical facts injected for the current room, before episodic hits. */
const MAX_CANONICAL = 15;
/** Run nodes attached to the graph — structure and recency, not vectors. */
const RUN_NODE_CAP = 200;

const clip = (text: string): string =>
  text.length > MAX_MEMORY_CHARS ? `${text.slice(0, MAX_MEMORY_CHARS)}…` : text;

export type KnowledgeContext = {
  /** Human project-room discussions, kept distinct from distilled AI facts. */
  chatText: string | null;
  chatRecalled: number;
  chatSources: RoomChatContext["sources"];
  /** The <memory> block: canonical facts + merged episodic recall, or null. */
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
      `SELECT session_id, MAX(created_at) AS last_run_at
         FROM agent_runs WHERE session_id = ANY($1) GROUP BY session_id`,
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
  if (!memoryEnabled() || !input.prompt.trim()) {
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

  // One parallel wave: every recall shares the same wall-clock budget instead
  // of queueing behind each other on the run's start path.
  const [perBank, canonical, repoHits] = await Promise.all([
    Promise.all(
      rooms.map((room) => recall({ bank: room.bank!, query: input.prompt, topK: PER_BANK })),
    ),
    recallCanonical({ bank: roomBank(input.currentSessionId) }),
    route.repo
      ? recallRepoContext(
          input.projectId ? [targetRepoRef, input.projectId] : [targetRepoRef],
          input.prompt,
        )
      : Promise.resolve([]),
  ]);

  const top = mergeRecalled(perBank.flat(), TOTAL);

  // Durable canonical facts lead: they are the load-bearing truths the sleep
  // model-refresh maintains, key-retrieved so episodic recall never finds them.
  const canonicalSeen = new Set<string>();
  const canonicalLines: string[] = [];
  for (const fact of canonical) {
    const key = `${fact.category}:${fact.name}`;
    if (canonicalSeen.has(key)) continue;
    canonicalSeen.add(key);
    canonicalLines.push(`- (${fact.category}) ${clip(fact.body.trim())}`);
    if (canonicalLines.length >= MAX_CANONICAL) break;
  }

  const memoryLines = [
    ...canonicalLines,
    ...top.map((memory) => `- ${clip(memory.content.trim())}`),
  ];
  const repoLines = repoHits
    .map((hit) => clip(hit.content.trim()))
    .filter(Boolean)
    .map((content) => `- ${content}`);

  return {
    memoryText: memoryLines.length > 0 ? memoryLines.join("\n") : null,
    repoText: repoLines.length > 0 ? repoLines.join("\n") : null,
    recalled: memoryLines.length,
    repoRecalled: repoLines.length,
    truncatedRooms,
    route,
  };
}
