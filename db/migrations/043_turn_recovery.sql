ALTER TABLE agent_turns
  ADD COLUMN execution_target text NOT NULL DEFAULT 'server' CHECK (execution_target IN ('local','server')),
  ADD COLUMN execution_token uuid,
  ADD COLUMN execution_lease_until timestamptz,
  ADD COLUMN prepared_at timestamptz,
  ADD COLUMN recovery_token uuid,
  ADD COLUMN recovery_after timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN recovery_error text;

UPDATE agent_turns t SET execution_target='local' WHERE EXISTS (SELECT 1 FROM runner_jobs j WHERE j.turn_id=t.id);
CREATE INDEX agent_turns_recovery_idx ON agent_turns(recovery_after,created_at)
  WHERE status IN ('preparing','queued','running');
