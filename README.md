# multiplayer-ai

A collaborative, browser-based IDE where several people and several AI coding
agents work in the same repository at the same time. Each "room" is a live
workspace with a file explorer, a code editor, a terminal, a team chat, and an
AI panel. Humans edit files while AI agents (Claude Code, Codex, Gemini) run
against the same working copy, and everyone sees the changes stream in as they
happen.

The guiding idea is that collaboration state is **git**, not a shared mutable
document: every change — human or agent — is committed, so the history is real,
conflicts are resolved by merge, and any room can be forked or merged like a
branch. `ARCHITECTURE.md` documents the load-bearing decisions in depth; this
file is the overview.

## Core concepts

- **Organization → Project → Room.** An organization holds projects; a project
  has one canonical repository (its shared `main`); a room is a fork of that
  project that people and agents work in. Access is role-based, with invitations
  and share links.
- **Room = branch.** Opening a room checks out its own working copy on a
  `session/<id>` branch. Publishing a room merges its work back onto the
  project's `main`; syncing pulls `main` back into the room.
- **Runs.** A single agent turn is a "run": a prompt, the agent's streamed
  thinking/tool-activity/reply, and the commit it produces. Runs are durable —
  they persist as a conversation others can watch and continue.

## How it works

### State is git, never a snapshot
The persistent state of a room is a set of git coordinates
(`repo_url · branch · head_sha`), not a filesystem image. Agent turns auto-commit
at the turn boundary; human editor edits are committed on a short debounce.
Working copies under the data root are a rebuildable cache — deleting them never
loses a session. See `ARCHITECTURE.md` for why rooms are separate per-room repos
rather than one shared checkout.

Git storage is selected at runtime: `APP_ENV=testing` keeps local repositories;
development and production store immutable Git bundles in S3-compatible storage,
with refs and fenced writer leases in Postgres. Server disks become disposable
caches. Configure `GIT_S3_BUCKET` and apply migration 031; existing installations
must backfill and verify before switching reads. See the
[Git storage and recovery guide](docs/git-storage.md). Inactivity only archives;
deletion requires admin confirmation and has a seven-day grace period.

### Agents are local CLIs, driven one prompt at a time
An agent run spawns the vendor CLI (`claude`, `codex`, or `gemini`) in one-shot
mode against the room's working copy. The app reuses the machine's existing CLI
login rather than handling API keys itself. The CLI's stdout is parsed into a
live stream of three kinds of output — reply, thinking, and tool activity — sent
to the browser as newline-delimited JSON. Whatever the agent changed is committed
when the run ends.

By default a run executes inline in the web server. When `AGENT_WORKER=1` (and
Redis is configured), runs are instead enqueued and executed by a separate worker
process, so a heavy or runaway agent never degrades the shared web server. The
client sees the same stream either way. The web and worker tiers can also run as
containers sharing one volume — see `docker/README.md`.

### Real time over Server-Sent Events
Live updates (file saved, someone is typing, run output, presence) are broadcast
to watchers over SSE, because the traffic is entirely server-to-client. Presence
and multiplayer cursors ride the same event layer. Concurrent edits to the same
file are reconciled with a three-way git merge rather than an OT/CRDT layer; a
true conflict surfaces to the editor instead of being silently overwritten.

### Shared memory with review and source evidence
Postgres stores episodes, facts, and procedures with their source IDs, approval
status, history, and typed links to decisions, messages, and code. Completed
exchanges and retryable memory jobs commit together. Project-fork code episodes
wait for Publish; extracted facts remain proposals until an editor approves them
in the room's **Memory** dialog. Replacing a decision records what it supersedes.

Keyword recall works without a sidecar. Optional Mnemosyne search returns record
candidates; the app checks current permissions, source freshness, and status in
Postgres before including anything in a prompt. Run `npm run worker` for indexing,
publication recovery, and optional model extraction. See the
[memory implementation guide](docs/memory-management.md) for setup and the flow.

### Repository context
Repository code is indexed in Postgres independently of conversation memory.
Migration `029_repo_hybrid_context.sql` requires pgvector; Compose now uses a
pgvector-enabled Postgres 18 image. Existing Postgres installations must install
the extension before running `npm run db:migrate`. Recreate the Compose Postgres
container with the new image while retaining its existing data volume.

The index covers all eligible tracked source, documentation, and configuration
files, without a repository-wide file/chunk cap. Tree-sitter extracts symbols
for TypeScript/JavaScript, Python, Go, and Rust; other text uses line chunks.
Generated/vendor paths and lockfiles are excluded. Binary files and files over
2 MiB are skipped and recorded in `repo_context_skipped_files`. Each retrieved
excerpt includes the repo ref, indexed commit, path, symbol, and line range.
The agent still reads its isolated checkout as ground truth.

Publish enqueues the approved project/room SHA; successful run completion,
editor saves, and completed uploads do the same for personal rooms and imports.
Project-room changes remain gated on publish. The worker consumes durable SQL jobs,
diffs commits, replaces changed files, removes deleted files, and atomically
publishes each complete snapshot. Unchanged chunks retain their embeddings.
Inline mode performs the same work in the web process; run `npm run worker`
with `DATABASE_URL` set for automatic recovery of interrupted jobs. Existing
approved index pointers are queued for rebuilding by the migration.

The default embedding model is free, local
[`nomic-embed-text:v1.5`](https://ollama.com/library/nomic-embed-text), served by
Ollama with 768-dimensional vectors. Compose starts `repo-embeddings` and a
one-time model download (`repo-embedding-model`, approximately 274 MB); downloaded
weights persist in `repo-embedding-models`. No API key is needed. The host endpoint
is `http://localhost:11435/v1/embeddings`; containers use
`http://repo-embeddings:11434/v1/embeddings`. `./start.sh` also starts the indexing
worker so failed jobs and missing vectors recover automatically.

To switch providers, set `REPO_EMBEDDING_URL` (full embeddings endpoint),
`REPO_EMBEDDING_MODEL`, `REPO_EMBEDDING_DIMENSIONS`, and optionally
`REPO_EMBEDDING_API_KEY`. For containerized web/worker, set
`REPO_EMBEDDING_CONTAINER_URL` too. Any embedding model exposed through an
OpenAI-compatible endpoint or compatibility proxy can be used. Optional query
and document prefixes are configurable; Nomic's task prefixes are automatic.
Set the URL/model explicitly empty to disable semantic search (container URL
empty for Compose). Vectors are stored in pgvector; conversation memory stays
in Mnemosyne. Missing/failed embeddings fall back to Postgres keyword search.
Model and prefix changes trigger vector refreshes without
re-parsing source. Exact symbol/path hits lead, then reciprocal-rank fusion
combines keyword and cosine rankings. Vector search is exact within each
authorized repo; this version does not add a global approximate vector index.

Run `npm run test:repo-context` for real Git + embedded Postgres/pgvector tests.
With the Docker services running and migration 029 applied, run
`npm run test:repo-context:live` to verify real local-model embeddings and hybrid
retrieval in an isolated test schema. It cleans up its fixture data afterward.

### Project room chat memory
The context router also recognizes requests about team discussions, decisions,
requirements, and feedback. It searches human messages in accessible rooms of
the current project, selecting rooms by topic or `#room` / `#"Room name"`, and
authors by `@handle` or their display name. For example: “Implement the retry
policy Alice discussed in #backend.” Unknown or ambiguous explicit selectors
produce no chat context instead of widening the search. A scoped recap without
a topic uses recent messages; a topic search with no matches returns nothing.

Migration `028_room_chat_context.sql` adds stored full-text vectors and indexes
to `session_messages`, including existing history. English stemming and a simple
token index support prose and technical terms; room, author, and timestamp fields
retain provenance and allow filtering. Edits update the index automatically and
deleted messages are excluded. No sidecar or background reindex job is required.
Recall selects up to eight matches and two nearby messages on either side,
deduplicates them, and injects at most 6,000 characters into the AI's working
memory within the overall prompt budget. Each excerpt includes its room, author,
timestamp, and message ID; the run notice lists the rooms and people recalled.
Explicit “today” and “yesterday” filters use UTC; “last week” means the past seven
days. The planner uses deterministic signals and text ranking, not embeddings.
Only project room chats are included; organization channels and DMs are outside
this scope. Source messages remain the durable memory, rechecked on each lookup
instead of being copied into an unscoped shared memory bank.

### Graceful degradation
Optional infrastructure fails open. Redis powers presence, the live event bus,
and the run queue when present; without it the app runs single-process with an
in-memory bus. The memory sidecar is skipped entirely when absent. The product
works with nothing but Postgres and the app itself.

## Typical workflows

- **Collaborate in a room.** Open a room, browse and edit files in the editor,
  use the terminal, and chat with the team. Edits commit automatically; other
  members see them live.
- **Run an agent.** Write a prompt in the AI panel, pick an agent and model, and
  watch it think, use tools, and edit files in real time. The result is committed
  and recorded as a run others can open and continue.
- **Reference other chats.** Mention another room or run with `@room/<id>` to
  pull its relevant context into the current prompt.
- **Publish / sync.** Merge a room's work up to the project's `main`, or pull the
  latest `main` down into a room. Conflicts abort cleanly and are reported.
- **Develop the app.** `./start.sh` brings up the backing services, applies
  migrations, and starts the dev server in one command.

## Technology

| Area | Choice |
| --- | --- |
| Web / API | Next.js (App Router) with React; the repo pins a specific Next build — read `AGENTS.md` before changing framework code |
| Language | TypeScript |
| Database | PostgreSQL (session/run/org metadata; git holds the code itself) |
| Real time | Server-Sent Events; Redis pub/sub across processes, in-memory otherwise |
| Queue | BullMQ on Redis for agent runs; Postgres outboxes for memory and repository indexing |
| Terminal | node-pty + xterm.js |
| Agents | Claude Code, Codex, and Gemini CLIs, run locally |
| Memory | Postgres records, lifecycle, and edges; optional Mnemosyne search and model extraction |
| Desktop | Electron shell around the same app |
| Styling | Tailwind CSS |
| Local services | Docker Compose (Postgres, Redis, pgAdmin, the sidecar) |

## Repository layout

```
app/
  api/            HTTP + streaming endpoints (auth, orgs, projects, sessions, runs, ai, terminal)
  components/     UI, including components/workspace/ (the room IDE)
  lib/            server + shared logic
    session/      git-native room repos, working copies, locks
    ai/           agent catalog, run execution, streaming, memory
    queue/        BullMQ run queue (legacy consolidation helpers retained)
    events/       SSE event bus (Redis / in-memory)
    presence/     who is online (Redis / in-memory)
    project/, org/, auth/, terminal/
worker/           standalone worker process (agent runs, memory and repo jobs)
db/               SQL migrations + runner
docker/           Dockerfiles and compose service configs
desktop/          Electron entry point
ARCHITECTURE.md   the load-bearing design decisions
docker/README.md  host vs. containerized run topologies
```

## Getting started

Prerequisites: Node.js, Docker (for the local services), and at least one agent
CLI installed and signed in (for example `claude`).

```bash
cp .env.example .env      # configure GIT_S3_BUCKET and credentials; APP_ENV=testing uses local disk
./start.sh                # services -> migrations -> dev server
```

Then open http://localhost:3000. Other entry points:

```bash
./start.sh services       # just the backing services; start the app yourself
npm run dev               # the Next.js dev server on its own
npm run worker            # background memory/repo jobs; agent runs when enabled
npm run start             # the Electron desktop app
npm test                  # the test suite
```

Configuration is read from `.env` — see `.env.example` for every setting,
including `REDIS_URL`, `AGENT_WORKER`, the memory sidecar, and optional memory
extraction. Postgres memory remains available when those optional services are off.

### Desktop distribution

`npm start` builds the desktop assets and starts a local development server.
`npm run desktop:attach` opens desktop connection settings without starting a
server. Packaged apps connect to an HTTPS workspace and include their own runner;
they do not require npm, this repository, or a local database. Git and the chosen
AI CLI are still required to execute tasks locally.

Use `npm run desktop:dist` for preview installers in `desktop-dist/` and
`npm run desktop:release` for credential-gated signed releases. See
[desktop release instructions and shipment gates](docs/desktop-release.md).
