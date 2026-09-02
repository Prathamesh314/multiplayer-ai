/*
 * Archiving an agent run.
 *
 * A run is durable history, so it is never deleted — but a member can tuck their
 * own finished chats out of the active list. Archiving is that: a soft, personal
 * hide that only the run's starter may set (enforced in the route, the same
 * starter-only rule as rename). Null means live; a timestamp means archived.
 */
ALTER TABLE agent_runs
  ADD COLUMN archived_at timestamptz;

-- The room's live run list skips archived rows, so index the common case.
CREATE INDEX agent_runs_active_idx ON agent_runs (session_id, created_at DESC)
  WHERE archived_at IS NULL;
