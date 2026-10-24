-- AI tools a computer has installed but is not signed in to. They take no work
-- (agent_ids lists only the tools ready to run), but Set up AI can then say
-- "sign in" with the right command instead of "install it".
ALTER TABLE runner_devices
  ADD COLUMN signed_out_agent_ids text[] NOT NULL DEFAULT '{}';
