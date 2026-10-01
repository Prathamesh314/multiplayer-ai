# Persistent local runner workspaces

The hosted app uses each member's own runner and AI account. A room repository
has one persistent local Git worktree per server/user/device data directory.
Chats and successive turns for that repository reuse its files and branch.
Different rooms have different worktrees. A handoff to another computer fetches
the accepted commit into that computer's own workspace.

Room checkouts of the same explicitly selected project repository share a bare repository cache locally. Different repositories in a project have separate caches.
Imported repositories have separate caches: an import is not assumed to be the
same codebase merely because its name or source URL matches another import.
Server repositories and their room authorization boundaries remain separate.

## Turn lifecycle

1. Lock the workspace for this turn across runner processes.
2. Fetch the authorized room branch into the local cache. Fetches and worktree
   creation are serialized per cache; independent workspaces can otherwise run
   without holding that cache lock.
3. Create the workspace branch/worktree on first use. On later turns, verify its
   repository and branch, require a clean tracked/untracked state, and only
   fast-forward to the job's exact base commit. Never hard-reset or clean it.
4. Record a durable attempted-turn ref before invoking the agent, preventing
   automatic replay of a paid turn after restart.
5. Run the user's configured CLI inside the persistent workspace.
6. Commit changes and retain a local `refs/turns/<turnId>` candidate before
   pushing it to the same ref on the server. The runner never pushes directly
   to the server's room branch or project main.
7. Release the workspace lock; the existing completion outbox reports the
   result. Server verification, turn ownership, and compare-and-swap promotion
   still decide whether the candidate becomes the shared room head.

If a candidate has not been accepted, the workspace cannot be reset backwards
to an older job base. Its commit is preserved, and the new turn stops with a
recovery message. Once the accepted base includes the local head, reuse works.

This is development isolation, not a security sandbox. Worktrees on one device
share Git storage and the user's OS permissions. The runner serializes its own
writes, but cannot prevent a person or unrelated process from editing the folder
outside the runner. Avoid external edits while its agent is active.

## Local storage

Editable files are created on the **first local agent run**, by default at
`~/multiplayer-ai/workspaces` on macOS/Linux and
`%USERPROFILE%\multiplayer-ai\workspaces` on Windows:

```text
multiplayer-ai/workspaces/
  frontend--<repository-id>/
    alice-room--<room-repository-id>/
    bob-room--<room-repository-id>/
  backend--<repository-id>/
    alice-room--<room-repository-id>/
```

This means one checkout per repository in a room, shared by all chats in that
room, not one checkout per chat. A room can contain multiple repositories.
Readable names have short stable ID suffixes to avoid collisions. Names are
sanitized for all three platforms and pinned when created: renaming a room or
repository never moves or loses its checkout. These are real Git worktrees;
each `.git` file points to the shared local cache, not another full clone.

In **Desktop settings → Local worktrees**, use **Open folder** or pause the
runner and choose **Change location**. The tray also offers **Open local
worktrees**. A new location affects only new worktrees; existing bindings keep
their saved absolute paths. Open those older paths directly or list them with
the CLI. No folders are automatically deleted or silently relocated by this
setting.

The desktop app bundles its runner. Browser users can install the standalone
runner from their workspace without cloning this application's source code:

```sh
npm install --global https://workspace.example/downloads/multiplayer-ai-runner.tgz
multiplayer-ai-runner pair --server https://workspace.example --code RN-XXXX-XXXX --workspaces ~/multiplayer-ai/workspaces
multiplayer-ai-runner start --workspaces /path/to/new/worktrees
multiplayer-ai-runner workspaces
multiplayer-ai-runner workspaces --json
```

Pairing saves the location; `start --workspaces` overrides it for that process.
These commands work from any directory after installation. Node.js 22+ and Git
are prerequisites for the standalone CLI. See [runner installation](../runner/README.md).
The listing reads the selected runner's private data directory (`--data` to
override, or `RUNNER_CONFIG` to select a desktop runner configuration).

Git history, locks and recovery metadata remain under the private runner data
directory (`~/.multiplayer-ai-runner` for the standalone CLI; `runner-data`
inside Electron's user-data directory for the desktop app):

```text
workspaces-v1/<server-and-user-hash>/
  repos/<cache-hash>.git       Shared Git objects, room refs, candidate history
  bindings/<hash>.json         Pins cache identity and absolute worktree location
  layouts/<cache-hash>.json    Pins the readable repository folder name
  locks/workspace-<hash>/      Held throughout agent execution and push
  locks/cache-<hash>/          Held during shared Git operations
```

Each worktree has a local `workspace/<room-repository-hash>` branch. Device
tokens are passed to Git in individual authenticated commands and are not
stored in cache configuration. Changing provider accounts does not recreate the
workspace; different app users and server URLs get different cache namespaces.

Ignored files such as `.env.local` and `node_modules` remain between turns.
They are not automatically copied from another checkout, installed, uploaded,
or transferred during handoff. A remote update that would overwrite an ignored
local file is refused. Configure dependencies and local credentials explicitly
on each execution machine.

## Recovery and upgrade

- **Unfinished edits:** the error names the workspace folder. Inspect `git status`
  there and save/move the work before starting another turn. Committing locally
  preserves it but does not publish it; a commit outside the assigned base still
  needs review and reconciliation with the room's accepted history.
- **Undelivered/rejected commit:** inspect its local `refs/turns/<turnId>` and
  the failed turn. Preserve that ref while recovering or manually integrating
  the result. The runner does not automatically rerun the agent or merge a
  rejected result into a new turn.
- **Interrupted runner:** a lock is never stolen by age or a dead parent PID,
  because an agent child might still be running. Inspect the lock's `owner.json`,
  stop its runner and agent processes, inspect the workspace, then remove only
  that stale lock directory. Preserve workspace/cache files. A turn that already
  started cannot be replayed; submit a new turn after recovery.
- **Upgrade from hashed worktrees:** on next use, an existing
  `workspaces-v1/<scope>/work/<hash>` checkout moves to the readable directory
  with `git worktree move`. Git updates its registration and retains its index,
  staged/unstaged edits, untracked/ignored files, branch and attempted-turn
  markers. Dirty state still blocks agent execution after the move. The target
  is saved before moving so interrupted upgrades can retry. A destination
  collision or unsupported move (for example a worktree containing submodules)
  stops with an error and preserves the original files; it never falls back to
  copying, deleting or resetting them.
- **Older per-turn installations:** old `work/<turnId>` clones are left
  untouched for recovery. Their unpushed edits are not silently imported into
  another turn.
- **Older queued jobs:** `projectRepositoryId` is optional; jobs without it use a cache per room repository.
  A new runner receiving an old job creates a repo-scoped cache and pins that
  choice, so subsequent jobs with repository metadata keep the same workspace.
- **Retention:** local worktrees and caches persist across turns and restarts.
  Cloud room archival does not automatically delete local work. There is no
  automatic local pruning in this change; do not treat these directories as
  disposable while they contain unfinished work or pending results.

Activity and unpublished checkpoints now synchronize independently of the
runner's lifetime. Server imports, edits and merges operate on Git objects,
without permanent extracted checkouts. See [workspace synchronization](workspace-sync.md)
for offline review, snapshot restore, optional S3 storage and cold-cache settings.

## Validation

`npm run test:runner-workspaces` exercises real Git repositories and worktrees,
including reuse, shared caches, separate room files, process locks, handoff,
push failures, multi-repository rooms, dirty/ignored file preservation, upgrade
migration, folder names, root changes, and replay refusal.
`npm run test:handoff` covers the existing server promotion and ownership rules.
The optional PostgreSQL/browser handoff suite also uses these worktrees for its
two successive smart-HTTP runner turns.
