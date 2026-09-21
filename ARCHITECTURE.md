# Architecture

A short map of the load-bearing decisions. It documents *why* the system is
shaped the way it is and where its current boundaries are — read it before
changing the session, repo, or run-execution layers.

## Sessions are git, not snapshots

The whole persistent state of a session is a set of git coordinates —
`repo_url · session_branch · head_sha` (plus base branch, fork point, and a few
cache-validity hashes) — **not** a filesystem or container snapshot. Git is the
source of truth; the working copy is a disposable cache.

- **Invariant: never uncommitted.** Agent turns auto-commit at turn boundaries
  (`app/api/ai/run/route.ts`); human editor edits get a debounced WIP commit.
  If the design ever starts storing a working-tree *blob*, it has drifted back
  to snapshotting — that is the failure mode to watch for.
- **Resume = `clone + checkout <sha>`.** `<root>/work/<id>` is rebuildable from
  the bare repo on demand (`ensureWork`), so deleting all of `work/` must never
  lose a session.
- Session metadata lives in Postgres. Testing stores bare repos under
  `MULTIPLAYER_AI_DATA`; development/production use immutable S3 bundles plus
  Postgres refs, generations, and writer leases (migration 031). Node-local bare
  repos and working trees are disposable caches. See [Git storage](docs/git-storage.md).

## Project = canonical repo, room = branch

Multiplayer collaboration is modeled as a fork/merge graph, not a shared
checkout:

- Each **project** has one canonical bare repo (`<root>/projects/<id>.git`)
  holding the `main` everyone shares (`ensureProjectRepo`).
- Each **room/session** is a *fork* of it: its own bare repo + working copy that
  keeps the project repo as a `project` remote (`forkRoomFromProject`). A room
  works on its `session/<id>` branch.
- `publishRoom` merges the room back onto the project's `main` (fetch → merge →
  fast-forward push; a conflict aborts cleanly and is reported, leaving both
  sides untouched). `syncRoom` is the reverse — pull `main` into a room.
- Rooms are not opened by hand: each project member has exactly **one** room
  (migration 017, `ensureMemberRoom`), created for them, named after their
  handle, renameable. AI sessions (`agent_runs`) multiply *inside* a room, not
  rooms inside a project. Viewers, being read-only, own no room until promoted.

**Why not a single shared repo everyone branches inside?** A working tree has
exactly one HEAD and serializes on `index.lock` (hence `withRepoLock`), so
concurrent agents *require* per-actor working copies regardless. Separate
per-room repos also give the isolation boundary that makes retention
(archive/delete per room) and public/private room access control tractable —
git has no per-ref ACLs within one repo.

**A room is not bound to its project's codebase.** Beyond its fork, a room can
hold any number of *imported* repos (`room_repos`, migration 020;
`app/lib/session/roomRepos.ts`): a member picks a folder in the composer's
repo dropdown and chats about it right there. Each import mints an id from the
session alphabet, so the whole git layer — `barePath`/`workPath`, seeding,
locking, `ensureWork`, `commitWork` — operates on it unchanged; the id *is*
the repo handle. Every chat (`agent_runs.repo_id`) is bound to the repo it
works on (null = the fork), a thread never switches codebases midway, and the
sidebar sub-groups each person's chats per repo. Imported repos are
standalone: no project remote, so publish/sync never touch them, and — having
no publish step to approve their work — their exchanges skip the
approval-gated memory staging and ingest directly.

## Run execution is local-first, cloud-fallback

Agents execute on the *initiating member's own machine* when one of their
paired devices is online (docs/local-execution.md) — their CPU, their AI
login — and on the server otherwise. One job shape (`AgentRunJob`), three
transports, one browser contract:

1. **Local:** the run route parks the job in `runner_jobs`; the user's runner
   claims it (atomic `SKIP LOCKED`, long-poll `/api/runner/claim`), fetches
   the repo over the device-authenticated git smart-HTTP endpoint
   (`/api/git/[repoRef]/…` — deny non-fast-forward, deny deletes), executes,
   streams events up (`/api/runner/runs/[id]/events` → the per-run Redis
   channel), and reports `/complete`, where the claimed commit is verified
   against the bare repo before any head moves. Requires Redis; a job no
   device collects within ~20s is atomically reclaimed and falls back.
2. **Server worker:** BullMQ, when the queue is enabled.
3. **Inline:** in the web process, so local dev needs no extra infrastructure.

Local and cloud runs end through one shared finalization
(`app/lib/ai/finalize.ts`): head advance, transcript turn, diff stats, room
events, memory ingest — indistinguishable from the transcript out. The runner
itself stays dumb: it states facts and never writes the database.

An in-flight server-side process remains on its worker, but confirmed commits
are durable in cloud storage and any node can restore them. Git operations use
fenced Postgres leases rather than relying on shared filesystem locks in cloud
mode. The hosts still need Git and temporary disk; this is not an edge-runtime
execution service. Retention archives before cache removal and never deletes
code for inactivity.

## Graceful degradation

Optional infrastructure fails open, so the product still works when it is
absent:

- **Presence:** Redis when `REDIS_URL` is set, in-process otherwise
  (`app/lib/presence/index.ts`).
- **Shared memory:** Postgres keyword retrieval always works. Optional Mnemosyne
  adds semantic candidates; delivery failures remain in `memory_jobs` for retry.

## The knowledge layer

There are two separate structures in `app/lib/knowledge/`:

- `graph.ts` derives project → visible rooms → runs plus repository context.
  This tree chooses accessible sources and ranks room activity; it is not a fact
  graph. `router.ts` chooses own-room/code context or broader project discussion.
- `memory_edges` persists typed relationships between source-backed memory
  records, messages, and code turns: supersedes, supports, contradicts,
  discussed_in, implemented_by, and mentions_file. Recursive SQL traverses up to
  four hops. No separate graph database is needed.

Migration 030 adds `memory_records`, `memory_events`, `memory_edges`, and
`memory_jobs`. Run completion stores its historical episode and outbox jobs in
the transcript transaction. Model extraction creates multiple proposed facts or
procedures with exact evidence quotes. Editors explicitly approve, replace, or
retract claims. Project-fork code episodes additionally need a verified ancestor
commit in project main. Publish triggers this check; a durable job retries it
after crashes. Publishing an episode does not approve the model's claims.

The worker uses Postgres leases and retry backoff, without Redis for memory.
Approved records may be projected into Mnemosyne `records-<roomId>` banks with
stable IDs and revisions. Autonomous sidecar consolidation is disabled. The app
uses candidates from those banks plus Postgres full-text search, then rechecks
source hashes, permissions, scope, and lifecycle before returning attributed
records. Supersession traversal resolves an old decision to its current approved
replacement. Legacy free-form sidecar facts are not injected into prompts.

Repository retrieval is independent: migration 029 stores per-SHA snapshots,
symbol/line chunks, full-text indexes, optional pgvector embeddings, and durable
indexing jobs in Postgres. The actual repositories and per-turn commits remain
on disk in Git. Memory edges point to verified turn SHAs and changed paths;
the agent still reads and edits the checkout through its tools.

See [the implementation guide](docs/memory-management.md) for configuration,
upgrade behavior, API and UI workflows, and the retrieval evaluation harness.
