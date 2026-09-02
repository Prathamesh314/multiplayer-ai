/*
 * Forked chat memory.
 *
 * "Fork" here means importing another chat's full transcript into a brand new
 * chat as its opening memory — not a live tool call, because the agent side of
 * a run is an external CLI subprocess (see agent_runs), not a loop this app
 * drives turn by turn. One row per fork event, holding the whole imported
 * transcript as a single blob; org/project/session aren't duplicated here
 * because they're reachable via run_id -> agent_runs -> sessions, and access is
 * already checked through project room visibility before a fork is allowed.
 */
CREATE TABLE ai_memories (
  id                  uuid PRIMARY KEY DEFAULT new_id(),
  run_id              uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  forked_from_run_id  uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  content             text NOT NULL,
  created_by          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ai_memories_content_present CHECK (length(btrim(content)) > 0)
);

CREATE INDEX ai_memories_run_idx ON ai_memories (run_id);
