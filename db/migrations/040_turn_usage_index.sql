-- Period quotas and usage count execution turns rather than conversations.
CREATE INDEX agent_turns_period_idx ON agent_turns(created_at, run_id);
