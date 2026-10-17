-- Manual or Auto approval for each chat.
--
-- Manual ('ask', the default) is how agents behaved: a tool that needs
-- permission (a shell command, a web fetch, an MCP connector) waits in the
-- chat until the driver allows or denies it. Auto ('auto') is the driver's own
-- choice to let their agent go ahead without asking: the server answers each
-- request "allowed" at once and keeps it, marked automatic, so the chat still
-- shows what the agent did. Switching to Auto also allows what is waiting.
--
-- runner_devices.supports_permissions marks runners that can ask at all;
-- older ones make the CLI refuse such tools, and the app says to update.
--
-- Additive with defaults, so the previous release ignores all of it.
ALTER TABLE agent_runs
  ADD COLUMN permission_mode text NOT NULL DEFAULT 'ask' CHECK (permission_mode IN ('ask', 'auto'));
ALTER TABLE agent_permission_requests
  ADD COLUMN automatic boolean NOT NULL DEFAULT false;
ALTER TABLE runner_devices
  ADD COLUMN supports_permissions boolean NOT NULL DEFAULT false;
