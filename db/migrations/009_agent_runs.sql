/*
 * Agent runs.
 *
 * A run is one member's agent session inside a room: "run a [priya]". Unlike the
 * old fire-and-forget /api/ai/run, a run is now a durable record with a stored
 * conversation, so a teammate can watch it live or scroll it back tomorrow.
 *
 * Delivery of a live run is still through the event bus; these tables are the
 * history, not the transport — the same split as session_messages.
 */

CREATE TABLE agent_runs (
  id         uuid PRIMARY KEY DEFAULT new_id(),
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Whose run this is. RESTRICT: a run's authorship outlives account deletion
  -- the same way session_messages' does.
  started_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- Which CLI agent, from app/lib/ai/catalog.ts: 'claude' | 'codex' | 'gemini'.
  agent_id   text NOT NULL,
  title      text,
  status     text NOT NULL DEFAULT 'running'
             CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  -- Git anchoring: HEAD when the run started, and the commit it produced.
  base_sha   text NOT NULL,
  result_sha text,
  exit_code  integer,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at   timestamptz,

  CONSTRAINT agent_runs_title_length CHECK (title IS NULL OR length(title) <= 200)
);

-- The run list for a room, newest first.
CREATE INDEX agent_runs_session_idx ON agent_runs (session_id, created_at DESC);
-- "Who is running something right now", for the room's activity dots.
CREATE INDEX agent_runs_live_idx ON agent_runs (session_id) WHERE status = 'running';

/*
 * The stored conversation for one run: human prompts, agent output and tool
 * calls, in order. seq is monotonic per run so ordering never depends on a
 * clock that two turns can share.
 *
 * author_user_id is set for 'user' turns — which is what makes "join as editor"
 * legible: several people's prompts land in the same run, each attributed. It
 * is null for agent/system/tool turns, which have no human author.
 */
CREATE TABLE agent_run_messages (
  id             uuid PRIMARY KEY DEFAULT new_id(),
  run_id         uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq            bigint NOT NULL,
  role           text NOT NULL CHECK (role IN ('user', 'agent', 'system', 'tool')),
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (run_id, seq),
  -- A 'user' turn without an author is unattributable; the others must not
  -- claim one. This is the invariant "join as editor" leans on.
  CONSTRAINT agent_run_messages_user_has_author CHECK (
    (role = 'user') = (author_user_id IS NOT NULL)
  )
);

-- Conversation read oldest-first, so the index matches the read.
CREATE INDEX agent_run_messages_run_idx ON agent_run_messages (run_id, seq);

/*
 * Who is watching or co-driving a run. Attention on one run, not access to the
 * room — that access is already settled by project_members. 'owner' is the
 * person who started it, 'editor' joined to send prompts, 'viewer' is watching.
 */
CREATE TABLE agent_run_participants (
  run_id    uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at   timestamptz,

  PRIMARY KEY (run_id, user_id)
);

CREATE INDEX agent_run_participants_user_idx ON agent_run_participants (user_id);
