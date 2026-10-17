-- MCP servers and plugins for AI agents, configured in the app instead of in
-- each member's own CLI. A project tool is shared with the project's members;
-- a personal tool belongs to one member and applies to all of their chats.
--
-- Tools run on members' computers, so a project tool is used for a member only
-- after that member approves it, and the approval is bound to the tool's exact
-- definition (spec_hash): changing what it runs asks everyone again.
--
-- Secrets never live here. A definition refers to them as ${NAME}; each
-- computer fills those in from its own store when it starts an agent.
-- runner_devices.secret_names lists which names a computer holds (never values).
--
-- Additive, so the previous release ignores all of it.
CREATE TABLE agent_tools (
  id uuid PRIMARY KEY DEFAULT new_id(),
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  owner_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('mcp', 'plugin')),
  name text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,47}$'),
  spec jsonb NOT NULL,
  spec_hash text NOT NULL CHECK (spec_hash ~ '^[0-9a-f]{64}$'),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((project_id IS NULL) <> (owner_id IS NULL))
);
CREATE UNIQUE INDEX agent_tools_project_name ON agent_tools(project_id, name) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX agent_tools_owner_name ON agent_tools(owner_id, name) WHERE owner_id IS NOT NULL;

CREATE TABLE agent_tool_approvals (
  tool_id uuid NOT NULL REFERENCES agent_tools(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  spec_hash text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tool_id, user_id)
);

ALTER TABLE runner_devices
  ADD COLUMN secret_names text[] NOT NULL DEFAULT '{}',
  ADD COLUMN supports_agent_tools boolean NOT NULL DEFAULT false;
