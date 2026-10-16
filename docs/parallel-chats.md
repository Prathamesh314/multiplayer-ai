# Parallel chats

An ordinary chat works directly on its room repository's branch,
`session/<repoRef>`. A person runs one at a time per room, and each turn
promotes with a compare-and-swap on the room head. A **parallel chat**
(`agent_runs.isolation = 'isolated'`) works on a branch of its own, so one
person can run several agents against the same repository at once. It is
reviewed and merged when it is ready. Members' guide: **Run chats in
parallel** at `/docs/parallel-chats` in the app (source: `app/docs/content.ts`).

## Enabling

| Setting | Where | Effect |
|---|---|---|
| `PARALLEL_CHATS=1` | web process (`.env`, or `.env.production` for Compose) | New chats may be opened as parallel. The composer shows **⑂ Parallel** (reported by `/api/ai/agents` as `parallelChats`). |
| Runner with `supportsIsolatedChats` | members' computers | Current desktop app / `multicode-ai-runner`. Older runners never claim a parallel chat's turn; the run route answers "update the desktop app" instead. |
| `--parallel` / `RUNNER_MAX_PARALLEL` / `maxParallel` | runner, optional | Caps the turns one computer runs at once, if its owner wants a cap. |

Turning the flag off only stops *new* parallel chats. Existing ones keep
working, and can still be reviewed, merged, updated and discarded, so no work is
stranded. Migration `053_isolated_chats.sql` is additive and registered as
rollback-compatible: an older release ignores the columns and treats every chat
as shared. Merge or discard parallel chats before rolling back, because the older
release continues them on the room branch.

## Branch model

- **Fork:** opening a parallel chat creates `refs/heads/chat/<run id>` in the
  room repository's bare repo at the room head (`fork_sha`). Creation is
  race-safe (`update-ref` with an empty old value) and only accepts commits on
  the room branch.
- **Turns:** each turn's base is the chat's tip (`agent_runs.head_sha`), not the
  room head. Finalize promotes the candidate onto the chat branch with the usual
  compare-and-swap. It records the new tip on the run and leaves the room head,
  `file.saved` and repo-context indexing alone. Line totals on the run cover the
  chat's whole proposal, measured from where it last met the room.
- **Reviews, handoff and checkpoints** pin to the chat's tip.
- **Runner:** a parallel turn gets its own worktree and local branch, keyed by
  repository *and* chat, sharing the repository cache. It fetches only
  `chat/<run id>`. Runners still push only `refs/turns/*` and
  `refs/checkpoints/*`; the server's chat and room branches move only through
  verified promotion and the merge API. See [runner workspaces](runner-workspaces.md#parallel-chats).

## Admission

Every turn runs on the member's own computer, so nothing caps how many run at
once. `reserveTurn` takes the org advisory lock. Shared chats keep "one running
per person per room", because they share the room branch; parallel chats do not
hold the room slot. Hourly and monthly limits apply to every turn.
`checkRunAllowed` mirrors this for friendly errors before anything is created.
The old `run_concurrency_limit` and `parallel_chats_per_user` columns are no
longer read.

## Review and integration

`/api/sessions/[id]/runs/[runId]/branch` (`app/lib/ai/chat-branch.ts`):

| Call | Who | Does |
|---|---|---|
| `GET` | room access | Chat and room heads, merge base, ahead/behind, changed files with +/−, files with leftover conflict markers, and the chat's live `running` / `driverUserId` / `controlVersion` |
| `GET ?path=` | room access | Unified diff of one file from the merge base |
| `POST merge` | room editors | Merge into the room branch |
| `POST update` | the chat's driver (control version) | Merge the room's newer work into the chat branch |
| `POST discard` / `reopen` | the driver or room owner | Set aside or bring back; the branch is kept |

- **Merge commits, never squash.** Shared memory publishes a code episode only
  once its turn commit is an ancestor of the published branch. A squash would
  orphan every parallel chat's episodes. A clean merge is a fast-forward or a
  two-parent merge commit authored by the person merging.
- **Compare-and-swap on what was reviewed.** `merge` and `update` carry the chat
  and room heads the caller saw. Both must still match, under the repository
  lock and inside the transaction that records the result, or the request is
  refused with "changed; refresh".
- **Conflicts change nothing.** The answer is `409 { ok: false, reason:
  "conflict", files }`. With `allowConflicts`, `update` instead commits Git's
  conflicted merge tree, markers included, to the **chat's own branch**. The UI
  then puts a resolution prompt in the composer, and the agent fixes the files in
  an ordinary turn. `merge` refuses while the proposal still adds marker lines
  (`reason: "markers"`), so the room never receives conflicted code. No runner
  change is involved, and the server execution path works the same way.
- **Crash window.** Git moves before the transaction commits. On retry, a branch
  tip that is exactly the fast-forward, or a merge of exactly the recorded heads,
  is recognised as the earlier attempt and recorded. Any other move is refused.
- **Lifecycle.** A merge sets `merge_state = 'merged'`. New work after a merge
  reopens the proposal (`open`). A discarded chat takes no new turns until it is
  reopened. Every change appends a system message to the chat and publishes a
  `run.branch` room event.

Merging changes only the room branch. **Publish** remains the step that shares
room work with the project repository.

## Local disk

Each parallel chat has its own worktree, including any installed dependencies.
Nothing is pruned automatically (see ARCHITECTURE.md). Members run
`multicode-ai-runner workspaces prune` to list worktrees of merged, discarded or
archived chats, and add `--apply` to remove the clean ones whose commits the
server's chat branch already contains. An allowlisted `copyIgnoredFiles` (or
`RUNNER_COPY_IGNORED`) seeds a new chat worktree with ignored local
configuration such as `.env.local` from the room's checkout.

## Tests

- `npm run test:parallel-chats`: branch creation, concurrent promotion, admission,
  claim gating, reviews, merge, update, conflicts, discard and crash recovery,
  against real bare repositories.
- `npm run test:runner-workspaces`: concurrent chat worktrees, idle-checkpoint
  coordination, the ignored-file allowlist and pruning.
- `npm run test:workspace-ui` (`tests/parallel-chats.browser.mjs`): the
  composer toggle, sidebar state, Changes panel, diffs, a conflicting merge and
  the agent hand-off.
