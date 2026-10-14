-- Parallel chats. An "isolated" chat works on its own branch, chat/<run id>,
-- in the room repository's bare repo, forked from the room branch when the
-- chat opens. Its turns start from and promote onto that branch, so several
-- isolated chats on one repository can run at once without racing for the
-- room head. Its work reaches the room branch only through an explicit merge.
--
-- fork_sha is the room head the branch started from. head_sha mirrors the
-- branch tip after each promotion, as room_repos/session_repos.head_sha do for
-- the room branch; the Git ref stays the source of truth.
--
-- Additive with defaults, so the previous release ignores it and rolls back
-- cleanly. Existing and old-release chats are 'shared', which is exactly the
-- behaviour they already have.
ALTER TABLE agent_runs
  ADD COLUMN isolation text NOT NULL DEFAULT 'shared'
    CHECK (isolation IN ('shared', 'isolated')),
  ADD COLUMN fork_sha text,
  ADD COLUMN head_sha text,
  ADD COLUMN merge_state text
    CHECK (merge_state IN ('open', 'merged', 'discarded')),
  ADD COLUMN merged_sha text,
  ADD COLUMN merged_at timestamptz,
  ADD COLUMN merged_by uuid REFERENCES users(id),
  ADD CONSTRAINT agent_runs_isolated_branch CHECK (
    isolation = 'shared'
    OR (fork_sha IS NOT NULL AND head_sha IS NOT NULL AND merge_state IS NOT NULL)
  );

-- Isolated chats are bounded per person rather than one-per-room: they live
-- on separate branches and worktrees, so the remaining cost is the member's
-- own machine. Org and project concurrency limits still apply to every turn.
ALTER TABLE orgs
  ADD COLUMN parallel_chats_per_user integer NOT NULL DEFAULT 4
    CHECK (parallel_chats_per_user BETWEEN 1 AND 32);

-- An older runner keeps one worktree per room repository and fetches only the
-- room branch, so it must never claim an isolated chat's turn.
ALTER TABLE runner_devices
  ADD COLUMN supports_isolated_chats boolean NOT NULL DEFAULT false;
