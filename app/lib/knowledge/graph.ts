/*
 * The project knowledge graph.
 *
 * One root per project, fanning out to the rooms the caller can see, each room
 * fanning out to its runs (the individual chats), plus one repo node carrying
 * the indexed code context of the project's canonical `main`:
 *
 *   project ─┬─ repo                 bank: repo-<projectId>-<sha12>
 *            ├─ room ─┬─ run         bank: records-<roomId>
 *            │        └─ run
 *            └─ room ─── run         bank: records-<roomId>
 *
 * A *bank* is a vector collection in the mnemosyne sidecar. The graph is the
 * app-side structure that decides which banks a retrieval touches, and in what
 * order. Two deliberate choices shape it:
 *
 * - **Vectors live at room level; runs are structural.** The sidecar indexes
 *   approved record projections per room bank, so that is where the vectors
 *   are. Run nodes give the tree its chat level — recency ranking and
 *   provenance — without multiplying banks: a per-run bank would mean one
 *   recall call per chat, unbounded on the run's critical path.
 *
 * - **The graph is derived, never stored.** `projects → sessions → agent_runs`
 *   in Postgres is already the authoritative hierarchy; materializing a copy
 *   would only invite drift. Deletion therefore propagates for free: a deleted
 *   room drops out of `visibleRoomIds`, so it never enters the graph, so its
 *   bank is never queried again. The repo node gets the same property from
 *   per-SHA banks — when `main` advances, retrieval moves to the new bank and
 *   the old one is simply never addressed again.
 *
 * Everything in this module is pure (no DB, no network), so the traversal,
 * ranking, pruning, and merging logic is unit-testable in isolation; the I/O
 * that feeds it lives in `index.ts`.
 */

export type KnowledgeNodeKind = "project" | "room" | "run" | "repo";

export type KnowledgeNode = {
  kind: KnowledgeNodeKind;
  id: string;
  /** Human label: project id, room name, run title, or the repo SHA. */
  name: string;
  /** Room sidecar bank or logical repo snapshot label; null for structural nodes. */
  bank: string | null;
  /** Most recent activity (ms epoch) at or under this node; drives ranking. */
  lastActivity: number;
  children: KnowledgeNode[];
};

/*
 * Bank naming: the sidecar accepts only alphanumerics, hyphens, and
 * underscores — a colon-separated name is silently rejected (remember() is
 * fail-open), which is exactly the bug the original colon scheme shipped
 * with. Hyphens throughout, verified against the live sidecar.
 */

/** A room's memory bank. One bank per room keeps recall access-scoped per room. */
export function roomBank(sessionId: string): string {
  return `records-${sessionId}`;
}

/**
 * Logical graph label for an indexed repo snapshot. Repository retrieval now
 * uses Postgres chunks/pgvector, not this legacy sidecar bank identifier.
 * Keeping the label stable preserves graph consumers across the migration.
 */
export function repoBank(ref: string, headSha: string): string {
  return `repo-${ref}-${headSha.slice(0, 12)}`;
}

export type RoomInput = {
  id: string;
  name: string;
  /** Latest run or memory activity in the room (0 = no context yet). */
  lastActivity: number;
  runs?: { id: string; title: string | null; createdAt: number }[];
};

/** Materialize the graph from plain rows. Pure, so tests need no database. */
export function assembleKnowledgeGraph(input: {
  projectId: string;
  rooms: RoomInput[];
  /** The indexed HEAD of the project repo, when one exists. */
  repoSha?: string | null;
  repositories?: { id: string; name: string; sha: string }[];
}): KnowledgeNode {
  const rooms: KnowledgeNode[] = input.rooms.map((room) => ({
    kind: "room",
    id: room.id,
    name: room.name,
    bank: roomBank(room.id),
    lastActivity: Math.max(room.lastActivity, ...(room.runs ?? []).map((run) => run.createdAt)),
    children: (room.runs ?? []).map((run) => ({
      kind: "run" as const,
      id: run.id,
      name: run.title ?? run.id,
      bank: null, // runs share their room's bank; see the module header
      lastActivity: run.createdAt,
      children: [],
    })),
  }));

  const repositories = input.repositories ?? (input.repoSha ? [{ id: input.projectId, name: input.repoSha.slice(0, 12), sha: input.repoSha }] : []);
  const children: KnowledgeNode[] = [
    ...repositories.map(repository => ({
      kind: "repo" as const, id: `repo:${repository.id}`, name: repository.name,
      bank: repoBank(repository.id, repository.sha), lastActivity: 0, children: [],
    })),
    ...rooms,
  ];

  return {
    kind: "project",
    id: input.projectId,
    name: input.projectId,
    bank: null,
    lastActivity: Math.max(0, ...rooms.map((room) => room.lastActivity)),
    children,
  };
}

/** Visit every node. BFS surfaces the shallow structure first; DFS follows chains. */
export function* walk(root: KnowledgeNode, order: "bfs" | "dfs" = "bfs"): Generator<KnowledgeNode> {
  if (order === "bfs") {
    const queue: KnowledgeNode[] = [root];
    while (queue.length > 0) {
      const node = queue.shift()!;
      yield node;
      queue.push(...node.children);
    }
    return;
  }
  yield root;
  for (const child of root.children) yield* walk(child, "dfs");
}

/** First node matching the predicate, or null. */
export function findNode(
  root: KnowledgeNode,
  predicate: (node: KnowledgeNode) => boolean,
): KnowledgeNode | null {
  for (const node of walk(root)) if (predicate(node)) return node;
  return null;
}

/**
 * Remove a subtree from the graph, in place. Retrieval built from the pruned
 * graph never touches the removed node's bank — this is how an app-level
 * exclusion (a muted room, a redacted chat) would translate into "those vectors
 * are unreachable" without needing a delete API on the vector store.
 */
export function pruneNode(root: KnowledgeNode, id: string): boolean {
  const index = root.children.findIndex((child) => child.id === id);
  if (index >= 0) {
    root.children.splice(index, 1);
    return true;
  }
  return root.children.some((child) => pruneNode(child, id));
}

/** The repo node, when the graph carries one. */
export function repoNode(root: KnowledgeNode): KnowledgeNode | null {
  return findNode(root, (node) => node.kind === "repo");
}

/** How widely a retrieval fans out over the graph's rooms. */
export type GraphScope = "project" | "room";

/**
 * The bank-selection algorithm: which room banks one retrieval queries, in
 * priority order.
 *
 * - The caller's own room always comes first and always survives the cap, so a
 *   chat can recall its own memory even in a huge project.
 * - The rest are ordered by lastActivity, newest first — recently active rooms
 *   are the likeliest to hold relevant, current knowledge. (The flat
 *   predecessor of this module took Set iteration order here, i.e. arbitrary.)
 * - Rooms that never ran anything are skipped: their banks are empty, and each
 *   selected bank costs one recall call on the run's critical path.
 * - `scope: "room"` narrows to the caller's own room — the router chooses this
 *   for mechanical code prompts where a project-wide sweep is noise.
 *
 * When the cap truncates, the count is reported so the caller can say so
 * rather than silently narrowing.
 */
export function selectRoomBanks(
  root: KnowledgeNode,
  currentSessionId: string,
  options: { scope: GraphScope; maxBanks: number },
): { rooms: KnowledgeNode[]; truncatedRooms: number } {
  const rooms = [...walk(root)].filter((node) => node.kind === "room");
  const current = rooms.find((room) => room.id === currentSessionId) ?? null;

  if (options.scope === "room") {
    return { rooms: current ? [current] : [], truncatedRooms: 0 };
  }

  const rest = rooms
    .filter((room) => room.id !== currentSessionId && room.lastActivity > 0)
    .sort((a, b) => b.lastActivity - a.lastActivity);
  const ordered = current ? [current, ...rest] : rest;
  const chosen = ordered.slice(0, options.maxBanks);
  return { rooms: chosen, truncatedRooms: Math.max(0, ordered.length - chosen.length) };
}

/** The shape recall results share, however they were fetched. */
export type Scored = { content: string; importance: number; score: number };

/**
 * Merge recall hits from several banks into one ranked list: drop
 * exact-duplicate contents (the sidecar distills per room, but the same fact
 * can surface from two banks), sort by relevance score with importance as the
 * tiebreak, and keep the top `keep`.
 */
export function mergeRecalled<T extends Scored>(hits: T[], keep: number): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const hit of hits) {
    const key = hit.content.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(hit);
  }
  merged.sort((a, b) => b.score - a.score || b.importance - a.importance);
  return merged.slice(0, keep);
}
