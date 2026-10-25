-- Stop: the person running a chat can stop its current turn. The runner hears
-- it on its device's channel (and in its lease renewal) and stops the agent;
-- finalization keeps what the agent wrote and changed, marked as stopped.
ALTER TABLE agent_turns ADD COLUMN stop_requested_at timestamptz;
ALTER TABLE runner_devices ADD COLUMN supports_stop boolean NOT NULL DEFAULT false;
