-- A member's computer can host terminals for its owner: a shell in a chat's
-- worktree, relayed through this server. Runners that predate it, or whose
-- owner turned it off, are never asked to open one.
-- Additive with a default, so the previous release ignores it.
ALTER TABLE runner_devices
  ADD COLUMN supports_terminal boolean NOT NULL DEFAULT false;
