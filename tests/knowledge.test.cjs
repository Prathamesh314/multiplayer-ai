/**
 * Unit tests for the knowledge layer's pure core: the graph (assembly,
 * traversal, ranking, pruning, merging), the context router, and the repo
 * summarizer. These are the pieces that decide *which* vector banks a run
 * recalls from and what gets indexed — the access- and correctness-critical
 * logic — so they are exercised without a database or sidecar.
 *
 * Run with `npm run test:knowledge` — it compiles the TypeScript first.
 */
const assert = require("node:assert/strict");
const {
  assembleKnowledgeGraph,
  findNode,
  mergeRecalled,
  pruneNode,
  repoBank,
  repoNode,
  roomBank,
  selectRoomBanks,
  walk,
} = require("../.test-build/graph.js");
const { routeQuery } = require("../.test-build/router.js");
const {
  MAX_CHUNK_CHARS,
  MAX_CHUNKS,
  chooseSampleFiles,
  isIndexablePath,
  signatureLines,
  summarizeRepo,
} = require("../.test-build/repo-summary.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${err && err.message ? err.message : err}`);
  }
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** A three-room project: active, stale, and never-ran, plus an indexed repo. */
function fixtureGraph() {
  return assembleKnowledgeGraph({
    projectId: "proj-1",
    repoSha: "abcdef1234567890abcdef1234567890abcdef12",
    rooms: [
      {
        id: "room-stale",
        name: "bob",
        lastActivity: 1_000,
        runs: [{ id: "run-old", title: "old work", createdAt: 1_000 }],
      },
      {
        id: "room-active",
        name: "alice",
        lastActivity: 5_000,
        runs: [
          { id: "run-new", title: "new work", createdAt: 5_000 },
          { id: "run-mid", title: null, createdAt: 3_000 },
        ],
      },
      { id: "room-empty", name: "carol", lastActivity: 0, runs: [] },
    ],
  });
}

console.log("knowledge graph");

test("banks keep their historical names — existing vectors stay addressable", () => {
  // `session:<id>` predates the graph; renaming it would orphan every memory
  // already ingested. This is the backward-compatibility contract.
  assert.equal(roomBank("abc"), "session:abc");
  assert.equal(repoBank("p1", "abcdef1234567890"), "repo:p1:abcdef123456");
});

test("the graph materializes project → rooms → runs with a repo node", () => {
  const root = fixtureGraph();
  assert.equal(root.kind, "project");
  assert.equal(root.children.length, 4); // repo + 3 rooms
  const active = findNode(root, (n) => n.id === "room-active");
  assert.equal(active.kind, "room");
  assert.equal(active.bank, "session:room-active");
  assert.equal(active.children.length, 2);
  assert.equal(active.children[0].kind, "run");
  assert.equal(active.children[0].bank, null, "runs are structural, not banked");
});

test("the repo node carries the per-SHA bank", () => {
  const repo = repoNode(fixtureGraph());
  assert.ok(repo);
  assert.equal(repo.bank, "repo:proj-1:abcdef123456");
  assert.equal(repoNode(assembleKnowledgeGraph({ projectId: "p", rooms: [], repoSha: null })), null);
});

test("a room's lastActivity is the max of its own and its runs'", () => {
  const root = assembleKnowledgeGraph({
    projectId: "p",
    repoSha: null,
    rooms: [{ id: "r", name: "r", lastActivity: 10, runs: [{ id: "x", title: null, createdAt: 99 }] }],
  });
  assert.equal(root.children[0].lastActivity, 99);
  assert.equal(root.lastActivity, 99, "the root rolls activity up");
});

test("BFS yields shallow structure first; DFS follows a room's chain", () => {
  const root = fixtureGraph();
  const bfs = [...walk(root, "bfs")].map((n) => n.kind);
  // All rooms appear before any run in BFS.
  assert.ok(bfs.lastIndexOf("room") < bfs.indexOf("run"), `bfs order: ${bfs}`);
  const dfs = [...walk(root, "dfs")].map((n) => n.id);
  // In DFS a room's runs come directly after it, before the next room.
  const stale = dfs.indexOf("room-stale");
  assert.equal(dfs[stale + 1], "run-old", `dfs order: ${dfs}`);
});

test("findNode reaches leaf runs", () => {
  const run = findNode(fixtureGraph(), (n) => n.id === "run-mid");
  assert.ok(run);
  assert.equal(run.kind, "run");
});

test("selectRoomBanks puts the caller's own room first, then recency", () => {
  const { rooms, truncatedRooms } = selectRoomBanks(fixtureGraph(), "room-stale", {
    scope: "project",
    maxBanks: 8,
  });
  assert.deepEqual(
    rooms.map((r) => r.id),
    ["room-stale", "room-active"],
    "own room leads even though it is staler",
  );
  assert.equal(truncatedRooms, 0);
});

test("rooms that never ran anything are skipped — their banks are empty", () => {
  const { rooms } = selectRoomBanks(fixtureGraph(), "room-active", {
    scope: "project",
    maxBanks: 8,
  });
  assert.ok(!rooms.some((r) => r.id === "room-empty"));
});

test("…unless the empty room is the caller's own", () => {
  const { rooms } = selectRoomBanks(fixtureGraph(), "room-empty", {
    scope: "project",
    maxBanks: 8,
  });
  assert.equal(rooms[0].id, "room-empty", "own room always survives");
});

test("the bank cap truncates and reports, never silently narrows", () => {
  const many = assembleKnowledgeGraph({
    projectId: "p",
    repoSha: null,
    rooms: Array.from({ length: 12 }, (_, i) => ({
      id: `room-${i}`,
      name: `r${i}`,
      lastActivity: i + 1,
      runs: [],
    })),
  });
  const { rooms, truncatedRooms } = selectRoomBanks(many, "room-0", {
    scope: "project",
    maxBanks: 8,
  });
  assert.equal(rooms.length, 8);
  assert.equal(rooms[0].id, "room-0", "own room survives the cap");
  assert.equal(rooms[1].id, "room-11", "the rest are newest-first");
  assert.equal(truncatedRooms, 4);
});

test("scope 'room' narrows to the caller's own room only", () => {
  const { rooms, truncatedRooms } = selectRoomBanks(fixtureGraph(), "room-active", {
    scope: "room",
    maxBanks: 8,
  });
  assert.deepEqual(rooms.map((r) => r.id), ["room-active"]);
  assert.equal(truncatedRooms, 0);
});

test("pruning a room makes its bank unreachable to selection", () => {
  const root = fixtureGraph();
  assert.equal(pruneNode(root, "room-active"), true);
  const { rooms } = selectRoomBanks(root, "room-stale", { scope: "project", maxBanks: 8 });
  assert.ok(!rooms.some((r) => r.id === "room-active"));
  assert.equal(pruneNode(root, "no-such-node"), false);
});

test("pruning reaches nested nodes (a single run)", () => {
  const root = fixtureGraph();
  assert.equal(pruneNode(root, "run-mid"), true);
  assert.equal(findNode(root, (n) => n.id === "run-mid"), null);
});

test("mergeRecalled dedups, ranks by score then importance, and caps", () => {
  const merged = mergeRecalled(
    [
      { content: "dup", importance: 0.5, score: 0.9 },
      { content: "dup", importance: 0.5, score: 0.1 },
      { content: "low", importance: 0.9, score: 0.2 },
      { content: "tie-heavy", importance: 0.8, score: 0.5 },
      { content: "tie-light", importance: 0.2, score: 0.5 },
      { content: "  ", importance: 1, score: 1 }, // blank → dropped
    ],
    3,
  );
  assert.deepEqual(
    merged.map((m) => m.content),
    ["dup", "tie-heavy", "tie-light"],
    "score desc, importance breaks the tie, cap at 3",
  );
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

console.log("\ncontext router");

test("a code-shaped prompt routes to repo + own-room memory", () => {
  const route = routeQuery("fix the type error in app/lib/ai/prompt.ts");
  assert.equal(route.repo, true);
  assert.equal(route.graphScope, "room");
  assert.ok(route.signals.repo.length > 0);
});

test("a conversation-shaped prompt routes to the full graph, no repo", () => {
  const route = routeQuery("what did we decide about auth yesterday?");
  assert.equal(route.repo, false);
  assert.equal(route.graphScope, "project");
  assert.ok(route.signals.conversation.length > 0);
});

test("a mixed prompt routes to both, project-wide", () => {
  const route = routeQuery("refactor the login flow the way @alice and I discussed");
  assert.equal(route.repo, true);
  assert.equal(route.graphScope, "project");
  assert.ok(route.signals.repo.length > 0 && route.signals.conversation.length > 0);
});

test("a neutral prompt defaults to both, project-wide — the safe superset", () => {
  const route = routeQuery("help me plan out what to do next please");
  assert.equal(route.repo, true);
  assert.equal(route.graphScope, "project");
});

test("the empty prompt routes somewhere sane", () => {
  const route = routeQuery("");
  assert.equal(route.repo, true);
  assert.equal(route.graphScope, "project");
});

test("identifiers and inline code count as repo signals", () => {
  assert.ok(routeQuery("why does buildSharedMemory return null").signals.repo.includes("identifier"));
  assert.ok(routeQuery("what is `foo` here").signals.repo.includes("code-span"));
});

// ---------------------------------------------------------------------------
// Repo summarizer
// ---------------------------------------------------------------------------

console.log("\nrepo summarizer");

const PATHS = [
  "README.md",
  "package.json",
  "package-lock.json",
  "app/lib/graph.ts",
  "app/lib/deep/nested/leaf.ts",
  "node_modules/x/index.js",
  "public/logo.png",
  "worker/index.ts",
];

test("vendored dirs and lockfiles are never indexable", () => {
  assert.equal(isIndexablePath("node_modules/x/index.js"), false);
  assert.equal(isIndexablePath("package-lock.json"), false);
  assert.equal(isIndexablePath(".next/build/x.js"), false);
  assert.equal(isIndexablePath("app/lib/graph.ts"), true);
});

test("sampling picks docs and manifests first, then source shallowest-first", () => {
  const sampled = chooseSampleFiles(PATHS);
  assert.deepEqual(sampled.slice(0, 2), ["README.md", "package.json"]);
  assert.ok(sampled.indexOf("app/lib/graph.ts") < sampled.indexOf("app/lib/deep/nested/leaf.ts"));
  assert.ok(!sampled.includes("node_modules/x/index.js"));
  assert.ok(!sampled.includes("public/logo.png"), "binaries are not source");
});

test("the sampling cap holds", () => {
  const many = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
  assert.equal(chooseSampleFiles(many, 10).length, 10);
});

test("signatureLines extracts the API surface per language", () => {
  const ts = signatureLines("a.ts", "import x from 'y'\nexport function foo() {}\nconst hidden = 1\nexport const BAR = 2");
  assert.deepEqual(ts, ["export function foo() {}", "export const BAR = 2"]);
  const py = signatureLines("b.py", "import os\ndef main():\n    pass\nclass App:\n    pass");
  assert.deepEqual(py, ["def main():", "class App:"]);
  assert.deepEqual(signatureLines("c.css", "a { color: red }"), []);
});

test("summarizeRepo leads with the map, then manifests/docs, then signatures", () => {
  const files = new Map([
    ["README.md", "# My project\nIt does things."],
    ["package.json", JSON.stringify({ name: "demo", scripts: { dev: "next dev" }, dependencies: { react: "1" } })],
    ["app/lib/graph.ts", "export function walk() {}\nexport const X = 1"],
  ]);
  const chunks = summarizeRepo({ paths: PATHS, files });
  assert.equal(chunks[0].label, "map");
  assert.ok(chunks[0].content.includes("app/: 2 files"), chunks[0].content);
  assert.ok(chunks[0].content.includes("README.md"), "root files are listed");

  const pkg = chunks.find((c) => c.label === "package.json");
  assert.ok(pkg.content.includes('package "demo"'));
  assert.ok(pkg.content.includes("dev: next dev"));
  assert.ok(pkg.content.includes("react"));

  const readme = chunks.find((c) => c.label === "README.md");
  assert.ok(readme.content.includes("# My project"));

  const sig = chunks.find((c) => c.label === "signatures");
  assert.ok(sig.content.includes("app/lib/graph.ts:"));
  assert.ok(sig.content.includes("export function walk() {}"));
});

test("ignored paths never leak into the map", () => {
  const chunks = summarizeRepo({ paths: PATHS, files: new Map() });
  assert.ok(!chunks[0].content.includes("node_modules"));
});

test("every chunk respects the size cap and the count cap", () => {
  const paths = Array.from({ length: 200 }, (_, i) => `src/mod${i}.ts`);
  const files = new Map(
    paths.map((p) => [p, Array.from({ length: 12 }, (_, i) => `export function fn${i}_${p.length}() {}`).join("\n")]),
  );
  const chunks = summarizeRepo({ paths, files });
  assert.ok(chunks.length <= MAX_CHUNKS, `${chunks.length} chunks`);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length <= MAX_CHUNK_CHARS, `${chunk.label}: ${chunk.content.length}`);
  }
});

test("malformed package.json falls back to a raw excerpt", () => {
  const chunks = summarizeRepo({
    paths: ["package.json"],
    files: new Map([["package.json", "{not json"]]),
  });
  const pkg = chunks.find((c) => c.label === "package.json");
  assert.ok(pkg.content.includes("{not json"));
});

test("an empty repo summarizes to nothing", () => {
  assert.deepEqual(summarizeRepo({ paths: [], files: new Map() }), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
