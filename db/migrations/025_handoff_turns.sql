CREATE FUNCTION room_access_role(room_id text, actor_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = actor_id AND deleted_at IS NULL) THEN NULL
    WHEN s.org_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM org_members om WHERE om.org_id = s.org_id
      AND om.user_id = actor_id AND om.status = 'active'
    ) THEN NULL
    WHEN s.project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM project_members pm WHERE pm.project_id = s.project_id
      AND pm.user_id = actor_id AND pm.removed_at IS NOT NULL
    ) THEN NULL
    WHEN EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = s.project_id
      AND pm.user_id = actor_id AND pm.removed_at IS NULL AND pm.role = 'viewer')
      AND (s.visibility = 'public' OR EXISTS (
        SELECT 1 FROM session_members sm WHERE sm.session_id = s.id AND sm.user_id = actor_id AND sm.removed_at IS NULL
      )) THEN 'viewer'
    ELSE COALESCE(
      (SELECT sm.role FROM session_members sm WHERE sm.session_id = s.id
       AND sm.user_id = actor_id AND sm.removed_at IS NULL),
      CASE WHEN s.visibility = 'public' THEN COALESCE(
        (SELECT CASE pm.role WHEN 'manager' THEN 'editor' ELSE pm.role END
         FROM project_members pm WHERE pm.project_id = s.project_id
         AND pm.user_id = actor_id AND pm.removed_at IS NULL),
        (SELECT 'editor' FROM org_members om WHERE om.org_id = s.org_id
         AND om.user_id = actor_id AND om.status = 'active'
         AND om.role IN ('owner', 'admin'))
      ) END
    ) END
  FROM sessions s WHERE s.id = room_id AND s.deleted_at IS NULL
$$;

ALTER TABLE agent_runs ADD COLUMN driver_user_id uuid REFERENCES users(id);
UPDATE agent_runs SET driver_user_id = started_by;
ALTER TABLE agent_runs ALTER COLUMN driver_user_id SET NOT NULL;
ALTER TABLE agent_runs ADD COLUMN control_version integer NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN message_seq bigint NOT NULL DEFAULT 0;
UPDATE agent_runs r SET message_seq = COALESCE(
  (SELECT MAX(m.seq) FROM agent_run_messages m WHERE m.run_id = r.id), 0
);

CREATE TABLE agent_turns (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  driver_user_id uuid NOT NULL REFERENCES users(id),
  control_version integer NOT NULL,
  status text NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing', 'queued', 'running', 'completed', 'failed', 'cancelled')),
  payload jsonb,
  completion jsonb,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE UNIQUE INDEX agent_turns_one_active ON agent_turns(run_id)
  WHERE status IN ('preparing', 'queued', 'running');
CREATE INDEX agent_turns_run_idx ON agent_turns(run_id, created_at);

ALTER TABLE runner_jobs DROP CONSTRAINT runner_jobs_pkey;
ALTER TABLE runner_jobs ADD COLUMN turn_id uuid REFERENCES agent_turns(id);
ALTER TABLE runner_jobs ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY;
CREATE UNIQUE INDEX runner_jobs_turn_idx ON runner_jobs(turn_id);
ALTER TABLE runner_devices ADD COLUMN agent_ids text[] NOT NULL DEFAULT '{}';

CREATE TABLE run_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id),
  to_user_id uuid REFERENCES users(id),
  accepted_by uuid REFERENCES users(id),
  control_version integer NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  checkpoint_sha text,
  checkpoint_seq bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  resolved_at timestamptz,
  CHECK (to_user_id IS NULL OR to_user_id <> from_user_id),
  CHECK ((status = 'accepted') = (accepted_by IS NOT NULL)),
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX run_handoffs_pending ON run_handoffs(run_id) WHERE status = 'pending';
CREATE INDEX run_handoffs_history ON run_handoffs(run_id, created_at DESC);

CREATE FUNCTION default_run_driver() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.driver_user_id := COALESCE(NEW.driver_user_id, NEW.started_by);
  RETURN NEW;
END
$$;
CREATE TRIGGER agent_runs_default_driver BEFORE INSERT ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION default_run_driver();
