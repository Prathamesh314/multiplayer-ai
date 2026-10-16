-- Asking before an agent uses a tool that needs permission.
--
-- Agents run unattended on members' computers, so a tool that would normally
-- ask (fetching a web page, an MCP connector such as Google Drive, a shell
-- command) used to be refused outright. The runner now records each request
-- here; the chat shows it, and the member whose computer and AI account run the
-- chat (its driver) allows or denies it. "Always allow" adds the request's rule
-- to the chat, so later turns don't ask again.
--
-- Additive with defaults, so the previous release ignores all of it; older
-- runners never create requests and keep refusing as before.
CREATE TABLE agent_permission_requests (
  id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool text NOT NULL CHECK (length(tool) BETWEEN 1 AND 200),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  detail text CHECK (detail IS NULL OR length(detail) <= 4000),
  -- What "always allow" remembers, e.g. WebFetch(domain:docs.google.com) or
  -- mcp__claude_ai_Google_Drive. NULL when the request cannot be remembered.
  rule text CHECK (rule IS NULL OR length(rule) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
  remember boolean NOT NULL DEFAULT false,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX agent_permission_requests_run ON agent_permission_requests(run_id, created_at);
CREATE INDEX agent_permission_requests_pending ON agent_permission_requests(turn_id) WHERE status = 'pending';

-- Rules the driver chose to always allow in this chat; sent with each turn.
ALTER TABLE agent_runs
  ADD COLUMN allowed_tools text[] NOT NULL DEFAULT '{}';
