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
