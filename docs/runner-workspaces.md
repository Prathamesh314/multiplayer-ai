# Persistent local runner workspaces

The hosted app uses each member's own runner and AI account. A room repository
has one persistent local Git worktree per server/user/device data directory.
Chats and successive turns for that repository reuse its files and branch.
Different rooms have different worktrees. A handoff to another computer fetches
the accepted commit into that computer's own workspace.

Primary room forks in the same project share a bare repository cache locally.
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

Under the runner data directory (normally `~/.multiplayer-ai-runner`):

```text
workspaces-v1/<server-and-user-hash>/
  repos/<cache-hash>.git       Shared Git objects, room refs, candidate history
  work/<room-repository-hash>/ Persistent linked worktree
  bindings/<hash>.json         Pins the workspace's cache identity
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
- **Older installations:** old `work/<turnId>` clones are left untouched for
  recovery. New workspaces use the separate `workspaces-v1` namespace. Existing
  unpushed edits are not silently imported into another turn.
- **Older queued jobs:** `projectId` is optional and old runners can ignore it.
  A new runner receiving an old job creates a repo-scoped cache and pins that
  choice, so subsequent jobs with project metadata keep the same workspace.
- **Retention:** local worktrees and caches persist across turns and restarts.
  Cloud room archival does not automatically delete local work. There is no
  automatic local pruning in this change; do not treat these directories as
  disposable while they contain unfinished work or pending results.

## Validation

`npm run test:runner-workspaces` exercises real Git repositories and worktrees,
including reuse, shared caches, separate room files, process locks, handoff,
push failures, dirty/ignored file preservation, and replay refusal.
`npm run test:handoff` covers the existing server promotion and ownership rules.
The optional PostgreSQL/browser handoff suite also uses these worktrees for its
two successive smart-HTTP runner turns.
