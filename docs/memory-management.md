# Team memory: implementation and operations

Postgres is the memory book. Git holds the code. Mnemosyne is an optional search
index that helps find pages in that book. A search result never decides whether
a statement is approved, current, or visible to the person asking.

## Start here

Read these files in this order:

1. [`index.ts`](../app/lib/knowledge/index.ts): combines memory, room discussion,
   and repository context for an AI request.
2. [`030_memory_records.sql`](../db/migrations/030_memory_records.sql): the
   records, evidence, audit history, typed edges, and durable job schema.
3. [`memory-records.ts`](../app/lib/knowledge/memory-records.ts): writes episodes,
   creates proposals, and approves, retracts, or supersedes decisions.
4. [`memory-jobs.ts`](../app/lib/knowledge/memory-jobs.ts) and
   [`memory-extraction.ts`](../app/lib/knowledge/memory-extraction.ts): background
   indexing, publication recovery, and evidence-backed model extraction.
5. [`memory-retrieval.ts`](../app/lib/knowledge/memory-retrieval.ts): searches,
   resolves replacements, checks access and status, and formats attributed results.
6. [`memory-edges.ts`](../app/lib/knowledge/memory-edges.ts): verifies code/message
   links and traverses the graph. [`MemoryDialog.tsx`](../app/components/workspace/MemoryDialog.tsx)
   is the review interface.
7. [`repo-context.ts`](../app/lib/knowledge/repo-context.ts): the separate
   repository chunk/full-text/pgvector index, introduced by migration 029.

## Storage and data structures

| Structure | Purpose |
| --- | --- |
| `agent_runs`, `agent_turns`, `agent_run_messages`, `session_messages` | Authoritative conversation and execution evidence |
| `memory_records` | One episode, fact, or procedure per row; source IDs, author/time, scope, validity dates, status, revision, and optional parent/replacement |
| `memory_events` | Append-only lifecycle history with actor, time, and reason |
| `memory_edges` | Adjacency-list graph: source ID, typed relation, and a memory/message/turn or verified Git target |
| `memory_jobs` | Transactional outbox with operation, attempts, next retry, error, and an expiring worker lease |
| Full-text `tsvector` and GIN index | Keyword recall in Postgres without a semantic service |
| Mnemosyne `records-<roomId>` banks | Optional vector-backed recall of approved record projections carrying an ID and revision |
| Repository snapshots/chunks and pgvector | Separate code search keyed to a repository and commit; paths, line ranges, and symbols |
| Git bare repositories and working trees | Real code, commits, branches, and editable checkouts |

`graph.ts` still builds the **source-selection tree** in memory: project →
visible rooms → runs, plus repository context. `memory_edges` is a separate
persisted **relationship graph**. Supported relations are `supersedes`,
`supports`, `contradicts`, `discussed_in`, `implemented_by`, and `mentions_file`.
Edges stay within a room; cross-room retrieval searches accessible rooms
together. Graph inspection uses recursive SQL, up to four hops and 100 nodes.

## Write and review flow

1. The agent finishes a turn. Its transcript, completed status, historical
   episode, and indexing/extraction/publication jobs commit in one transaction.
   Replayed completion reports use the turn ID to avoid duplicate memories.
2. Ordinary Q&A and completed standalone/personal-repo work become approved
   **episodes**. This means the exchange happened; it does not endorse every
   assertion inside it. Project-fork code episodes remain proposed until Publish.
3. Publish checks whether the episode's exact commit is an ancestor of the
   published project head. Only matching episodes become approved. A durable
   publication job also checks main, covering crashes and late completion reports.
4. Optional model extraction creates up to 12 facts/procedures per exchange.
   Every model candidate needs an exact source quote. Model-provided authority,
   status, scope, and relationships are ignored. Candidates remain proposed.
5. An editor opens **Memory** in the room toolbar. They can turn an episode into
   a proposal manually, inspect its source chat/evidence, approve or retract it,
   replace an approved decision, and link a verified implementation. Publishing
   code never automatically endorses the model's inferred facts.
6. Approving a replacement atomically supersedes the old claim, closes its
   validity period, creates the edge/audit events, and queues the new revision.
   Concurrent reviews use expected revision numbers; conflicting edits fail with
   HTTP 409. Retraction and supersession are terminal; make a new sourced claim
   for a later correction.
7. The worker delivers approved projections to Mnemosyne. Failures remain
   queued with exponential backoff (up to one hour), rather than disappearing.
   Expired leases can be reclaimed. Delivery is at least once; retrieval dedupes
   record identities. Memory jobs use Postgres and do not require Redis.

## Read flow and permissions

The deterministic router selects code context, own-room memory, or broader
project discussion. It selects at most eight visible rooms, prioritizing the
current room and recent activity. Mnemosyne returns candidate record IDs;
Postgres also searches its text index. The final SQL read rechecks room access,
scope, source freshness, approved status, validity, and parent approval.

An old decision match can follow up to four `supersedes` edges to a current
approved replacement. Superseded/retracted/proposed text does not become a
current factual result. Each returned JSON record carries its source IDs,
author, time, kind, status, and verified code links. Prompt budgeting keeps
whole records so it cannot separate a claim from its attribution.

Source edits invalidate the saved source hash; soft deletion hides the memory,
and hard deletion cascades its records, jobs, and edges. Permission revocation
during a sidecar request is checked again before results reach the prompt.
Stale vectors can remain in the sidecar but cannot override these checks.
Physical vector garbage collection is not implemented; the sidecar remains a
disposable index, not the system of record.

After replacing or clearing the semantic store, run `npm run memory:reindex` to
requeue approved source-backed records, then run the worker. This administrative
command updates only delivery jobs, never approval state or conversation data.

## Setup and upgrade

```sh
npm run db:migrate
npm run worker
```

The worker loads `.env`/`.env.local`. `start.sh` also starts it automatically when
`DATABASE_URL` is configured. Web and worker must use the same database and Git
bucket/prefix in cloud mode; testing and migration shadow mode still share the
Git data directory. See [Git storage](git-storage.md). Keep their code versions
aligned when rolling out migrations 030 and 031.

Keyword memory needs no extra service. Set `MNEMOSYNE_URL` and
`MNEMOSYNE_MCP_TOKEN` for semantic search. Keep sidecar autonomous sleep disabled
so it cannot rewrite immutable record IDs/revisions; Compose enforces this.
`MEMORY_CONSOLIDATION` and the legacy canonical-fact path are no longer active.

To enable automatic proposals, configure a full chat-completions endpoint:

```dotenv
MEMORY_EXTRACTION_URL=http://litellm:4000/v1/chat/completions
MEMORY_EXTRACTION_MODEL=haiku-4-5
MEMORY_EXTRACTION_API_KEY=sk-litellm-local
```

That URL uses a Compose service name. A host-run worker needs a reachable host
endpoint; the bundled LiteLLM service is not exposed on a host port by default.
Its Claude adapter also requires `ANTHROPIC_API_KEY`. Without an extractor,
extraction jobs stay pending and manual proposals remain available.

Migration 030 recovers historical episodes from saved completed turns without
guessing transcript-message IDs. Historical project code is still gated until
the worker proves its commit is in main. Older staged exchanges with no exact
commit are preserved as gated proposals for inspection/retraction; they cannot
be automatically or manually approved without that evidence. A reviewer can
record a new human message confirming the decision and create a sourced fact.
Unattributable legacy sidecar summaries are never imported as approved facts.

## APIs

All routes authenticate the requester and enforce current room roles. Viewers
can read; editors/owners can mutate. Prefix: `/api/sessions/<roomId>/memories`.

| Method/path | Body or query |
| --- | --- |
| `GET /` | Optional `status`, `limit` (1–100), `before` cursor; returns memories and next cursor |
| `POST /` | `kind`, `text`, exactly one of `sourceMessageId` / `sourceMemoryId`, optional exact `evidenceQuote` |
| `GET /<id>` | Optional `hops` (0–4); returns nodes, edges, sources, audit events, and editor-visible pending jobs |
| `PATCH /<id>` | `status: approved` or `retracted`, expected `revision`, optional `supersedes` on approval |
| `POST /<id>/edges` | `relation` plus `memoryId`, `messageId`, or `turnId` and optional `path`, depending on relation |

Code links derive the repository and commit from a completed approved turn;
pasted arbitrary SHAs are not accepted. `mentions_file` additionally requires
an actual changed path. Supersession edges are created only by the lifecycle API.

## Verification and backend comparison

```sh
npm run test:memory
npm run db:test
npm run test:prompt
npm run test:knowledge
npm run test:repo
npm run eval:memory
```

The memory tests use an isolated PGlite database, real migrations, and injected
provider failures. They cover transaction rollback, retries/leases, publication
gates, provenance, supersession, stale results, visibility, and upgrade recovery.
Repository tests exercise real Git ancestry; extraction protocol tests use a
mock endpoint. Live provider quality requires a separately configured run.

`eval:memory` seeds disposable source records and checks cross-room decisions,
superseded decisions, unapproved proposals, private-room exclusions, and code
links. It reports recall at eight, forbidden hits, source attribution, latency,
and provider-reported cost. It is a retrieval benchmark, not an end-to-end answer
accuracy or extraction quality benchmark.

For a candidate backend, set `MEMORY_EVAL_ADAPTER` to a local module exporting
`createAdapter({ records })`. It returns `{ name, search, costUsd?, close? }`.
`search({ bank, query, topK })` returns `{ content, score, importance, bank }[]`;
content must start with `memory-record:<uuid>:<revision>\n`. Use isolated test
namespaces and report measured cost; absent cost stays `null`. Every provider
still passes through the production Postgres access/lifecycle checks. No Mem0
dependency or backend switch is introduced by this change.
