CREATE TABLE run_activity_batches (
  turn_id uuid NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  sequence integer NOT NULL CHECK (sequence > 0),
  object_key text NOT NULL,
  content_hash text NOT NULL,
  bytes integer NOT NULL CHECK (bytes BETWEEN 0 AND 262144),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, sequence)
);
CREATE TABLE workspace_snapshots (
  id uuid PRIMARY KEY,
  turn_id uuid NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  repo_ref text NOT NULL,
  device_id uuid NOT NULL REFERENCES runner_devices(id),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 120),
  base_sha text NOT NULL,
  head_sha text NOT NULL,
  index_sha text NOT NULL,
  snapshot_sha text NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (turn_id, sequence)
);
CREATE INDEX workspace_snapshots_run ON workspace_snapshots(run_id, created_at DESC);
ALTER TABLE agent_runs ADD COLUMN restore_snapshot_id uuid REFERENCES workspace_snapshots(id) ON DELETE SET NULL;
ALTER TABLE run_handoffs ADD COLUMN snapshot_id uuid REFERENCES workspace_snapshots(id) ON DELETE SET NULL;
CREATE TABLE git_archives (
  repository_key text PRIMARY KEY,
  object_key text NOT NULL,
  content_hash text NOT NULL,
  bytes bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
