-- Human assignments stay separate from AI prompts and never transfer control.
CREATE TABLE room_tasks (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  assignee_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX room_tasks_inbox_idx ON room_tasks (assignee_id, created_at DESC, id);
CREATE INDEX room_tasks_run_idx ON room_tasks (run_id, created_at DESC, id);
