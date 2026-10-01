-- Durable per-chat input queues. PostgreSQL owns order/acks; pub/sub only wakes
-- executors. BullMQ still dispatches server execution turns.
ALTER TABLE agent_turns ADD COLUMN input_closed_at timestamptz;
ALTER TABLE runner_devices ADD COLUMN supports_inputs boolean NOT NULL DEFAULT false;
CREATE TABLE agent_run_inputs (
  id uuid PRIMARY KEY,
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  control_version integer NOT NULL,
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 32000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivering','delivered','cancelled','failed','unconfirmed')),
  claim_id uuid UNIQUE,
  message_id uuid REFERENCES agent_run_messages(id) ON DELETE SET NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX agent_run_inputs_pending ON agent_run_inputs(turn_id,position) WHERE status IN ('queued','delivering');
CREATE INDEX agent_run_inputs_history ON agent_run_inputs(run_id,position DESC);
