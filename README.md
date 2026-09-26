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
- **Runs and turns.** A run is a durable AI conversation containing successive
  turns: prompts, streamed thinking/tool activity/replies, and resulting commits.
  Teammates can watch a chat, fork it, or accept a handoff to continue it.
- **Human tasks.** Tag a room member from any accessible AI chat to assign work,
  such as a code review. Tasks appear on their dashboard with a source chat link
  and a status, independently of who controls the AI conversation.

## How it works

### State is git, never a snapshot
The persistent state of a room is a set of git coordinates
(`repo_url · branch · head_sha`), not a filesystem image. Agent turns auto-commit
at the turn boundary; human editor edits are committed on a short debounce.
Accepted code versions can be rebuilt from the server's Git repositories.
Local working copies can also contain unfinished or undelivered work and must
be preserved during recovery. See `ARCHITECTURE.md` for the server repository
boundaries and [runner workspaces](docs/runner-workspaces.md) for local storage.

### Agents are local CLIs, driven one prompt at a time
An agent run spawns the vendor CLI (`claude`, `codex`, or `gemini`) in one-shot
mode against the room's working copy. The app reuses the machine's existing CLI
login rather than handling API keys itself. The CLI's stdout is parsed into a
live stream of three kinds of output — reply, thinking, and tool activity — sent
to the browser as newline-delimited JSON. Whatever the agent changed is committed
when the run ends.

The hosted Compose app requires the caller's paired local runner and disables
server agent execution. The runner keeps one persistent worktree per room
repository; successive chats/turns reuse it, including ignored dependencies and
local configuration. Rooms of the same project share a local bare Git cache.
Dirty workspaces and undelivered commits stop a new turn instead of being reset.
See [runner workspaces](docs/runner-workspaces.md) for the lifecycle and recovery.

Local development can still execute inline or opt into `AGENT_WORKER=1` with
Redis and the terminal execution gate enabled. The hosted background worker
handles indexing. See `docker/README.md` for deployment defaults.

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
- **Ask a teammate to help.** Open your chat or a teammate's chat, click
  **@ Assign task** below the conversation, select their `@handle`, describe
  the request, and click **Create task**. It appears under **Chat tasks** and
  in the assignee's dashboard under **My tasks**, with a link back to the chat.
  Track **To do**, **In progress**, **Done**, or **Cancelled**. Room owners and
  editors can assign tasks; the assignee or creator can update them while they
  retain the required room access. Task assignment does not invoke AI or transfer
  chat control. Lists refresh every five seconds while visible and on window
  focus. See [tasks from chats](docs/room-tasks.md) for permissions and storage.
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
| Human tasks | PostgreSQL assignments linked to AI chats; dashboard inbox and status tracking |
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
  api/            HTTP + streaming endpoints (auth, orgs, projects, sessions, runs, tasks, ai, terminal)
  components/     UI, including components/workspace/ (the room IDE)
  lib/            server + shared logic
    session/      git-native room repos, working copies, locks
    ai/           agent catalog, run execution, streaming, memory
    tasks/        human assignments, status lifecycle, room permission checks
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
cp .env.example .env      # optional; sensible dev defaults are built in
./start.sh                # services -> migrations -> dev server
```

Then open http://localhost:3000. Other entry points:

```bash
./start.sh services       # just the backing services; start the app yourself
npm run dev               # the Next.js dev server on its own
npm run worker            # background memory/repo jobs; agent runs when enabled
npm run db:migrate        # apply pending migrations when starting manually
npm run start             # the Electron desktop app
npm test                  # the test suite
npm run test:tasks        # task storage, permissions, retries, and pagination
```

Existing installations must apply migration `031_room_tasks.sql` with
`npm run db:migrate` before using task assignments. `./start.sh` applies pending
migrations automatically. Tasks need only Postgres and the app; no additional
service or worker is required.

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
