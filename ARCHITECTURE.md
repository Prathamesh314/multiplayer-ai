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
- Session *metadata* lives in Postgres (`sessions` table, migration 005). The
  data root (`MULTIPLAYER_AI_DATA`) holds only git state — see
  `app/lib/session/paths.ts`.

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

## Known boundary: run execution is server-local

Repos, working copies, and spawned agent CLI processes all live on the machine
that handles the request:

- `dataRoot()` is a local filesystem path.
- The run route `spawn`s the agent CLI as a child of the Next.js server process
  and streams its stdout/stderr back over the same request.

This ties a run to one machine. **The execution layer cannot be horizontally
scaled** without either shared storage for the data root plus sticky routing of
a room to its owning instance, or moving execution into per-room workers
addressed over a queue. This is a deliberate, acceptable ceiling for now — named
here so it is a conscious choice rather than an accidental assumption. A server
restart mid-run also orphans the child process and can leave a `running` row
that a reaper later reconciles; a durable job/worker model is the eventual fix.

## Graceful degradation

Optional infrastructure fails open, so the product still works when it is
absent:

- **Presence:** Redis when `REDIS_URL` is set, in-process otherwise
  (`app/lib/presence/index.ts`).
- **Shared memory:** the mnemosyne sidecar when `MNEMOSYNE_URL` is set; recall
  and ingest are skipped entirely otherwise, falling back to fork + `@room/chat`
  context (`app/lib/ai/mnemosyne.ts`).

## The knowledge layer

Cross-chat context is organized as a **knowledge graph** over the project
(`app/lib/knowledge/`): project → rooms → runs, plus one repo node. Each room
node maps to a vector bank in the sidecar (`session:<roomId>` — ingest writes
there, `app/lib/ai/shared-memory.ts`); the repo node maps to a per-SHA bank
(`repo:<projectId>:<sha12>`) distilled from the project's canonical `main`
(file map, manifests, docs, export signatures — `repo-context.ts`).

- The graph is **derived, never stored** — Postgres already owns the
  hierarchy, so deletion propagates for free: a deleted room never enters the
  graph and its bank is never queried again; an advanced `main` orphans the old
  repo bank. Only the indexed-SHA pointer is stored (migration 018).
- Every retrieval is gated by `visibleRoomIds` before the graph is built, so
  recall can never widen access.
- Ingestion is **approval-gated**: an exchange whose run changed files is a
  proposal, not knowledge — it stages in Postgres (migration 019) and enters
  the room's bank only when the user approves the code by *publishing* the
  room to `main` (`ingestApprovedExchanges`, hooked in the publish route,
  which also re-indexes repo context for the new HEAD). Unpublished work never
  becomes shared memory; pure Q&A exchanges ingest immediately, having no code
  to approve.
- A deterministic **router** (`router.ts`) classifies each prompt: code-shaped
  → repo context + own-room memory; conversation-shaped → project-wide memory,
  no repo; mixed/neutral → both. No LLM on the critical path, and the matched
  signals are returned so the choice is explainable.
- All recalls (episodic banks, canonical facts, repo bank) go out in one
  parallel wave (`index.ts`), bounded by the sidecar's 4s timeout; everything
  fails open per the section above.
