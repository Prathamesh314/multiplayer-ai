/*
 * The runner job queue: work addressed to a user's own machines.
 *
 * When a run routes local (docs/local-execution.md §3.2), its fully-assembled
 * job payload waits here for one of the initiating user's devices to claim
 * it. This is a *delivery* queue, not a history — the run's durable record
 * stays in agent_runs; a row here lives only from enqueue to completion (or
 * to the cloud-fallback reclaim when no device shows up).
 *
 * The payload is the same plain-data AgentRunJob that crosses the BullMQ
 * queue for server workers — one job shape, three transports (inline, worker,
 * runner) — assembled server-side so the runner never builds prompts or reads
 * the knowledge layer.
 */

CREATE TABLE runner_jobs (
  run_id      uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  -- Only this user's devices may claim it; denormalized for the claim query.
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload     jsonb NOT NULL,
  -- queued → claimed → done; 'reclaimed' means the cloud fallback took it
  -- back before any device did, and 'failed' that the lease died mid-run.
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'claimed', 'done', 'reclaimed', 'failed')),
  device_id   uuid REFERENCES runner_devices(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at  timestamptz,
  -- Renewed by the event up-stream; expiry means the device went dark mid-run.
  lease_expires_at timestamptz
);

-- The claim query: oldest queued job for one user.
CREATE INDEX runner_jobs_claim_idx ON runner_jobs (user_id, created_at) WHERE status = 'queued';
