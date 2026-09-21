-- Postgres owns memory identity, evidence, lifecycle and permissions. The
-- optional semantic service is an expendable search index of approved rows.
CREATE TABLE memory_records (
  id uuid PRIMARY KEY DEFAULT new_id(),
  room_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  org_id uuid REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('fact', 'episode', 'procedure')),
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 20000),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'superseded', 'retracted')),
  stated_by uuid REFERENCES users(id),
  speaker text NOT NULL DEFAULT 'user' CHECK (speaker IN ('user', 'agent', 'mixed')),
  stated_at timestamptz NOT NULL DEFAULT now(),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  source_message_id uuid REFERENCES session_messages(id) ON DELETE CASCADE,
  source_agent_message_id uuid REFERENCES agent_run_messages(id) ON DELETE CASCADE,
  source_run_id uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  source_turn_id uuid REFERENCES agent_turns(id) ON DELETE CASCADE,
  source_hash text,
  evidence_quote text,
  repo_ref text,
  commit_sha text CHECK (commit_sha IS NULL OR commit_sha ~ '^[0-9a-f]{40,64}$'),
  parent_id uuid REFERENCES memory_records(id) ON DELETE CASCADE,
  supersedes uuid REFERENCES memory_records(id) ON DELETE SET NULL,
  publish_gated boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('english', text) || to_tsvector('simple', text)
  ) STORED,
  CHECK (num_nonnulls(source_message_id, source_agent_message_id, source_run_id, source_turn_id) > 0),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (supersedes IS NULL OR supersedes <> id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (NOT publish_gated OR status <> 'approved' OR published_at IS NOT NULL)
);
CREATE INDEX memory_records_scope ON memory_records(room_id, status, stated_at DESC, id);
CREATE INDEX memory_records_search ON memory_records USING gin(search_document);
CREATE INDEX memory_records_parent ON memory_records(parent_id);
CREATE INDEX memory_records_turn ON memory_records(source_turn_id);

-- Database validation also protects internal/background callers, not only API
-- handlers. Scope and author are derived from the authoritative source.
CREATE FUNCTION validate_memory_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s sessions; source_room text; source_body text; source_author uuid;
BEGIN
  SELECT * INTO STRICT s FROM sessions WHERE id = NEW.room_id;
  NEW.org_id := s.org_id;
  NEW.project_id := s.project_id;
  IF NEW.source_message_id IS NOT NULL THEN
    SELECT session_id, body, user_id INTO STRICT source_room, source_body, source_author
      FROM session_messages WHERE id = NEW.source_message_id AND deleted_at IS NULL;
    IF source_room <> NEW.room_id THEN RAISE EXCEPTION 'Memory source room mismatch'; END IF;
    NEW.source_hash := md5(source_body);
    NEW.stated_by := source_author;
  END IF;
  IF NEW.source_agent_message_id IS NOT NULL THEN
    SELECT r.session_id, m.body, m.author_user_id INTO STRICT source_room, source_body, source_author
      FROM agent_run_messages m JOIN agent_runs r ON r.id = m.run_id WHERE m.id = NEW.source_agent_message_id;
    IF source_room <> NEW.room_id THEN RAISE EXCEPTION 'Memory source room mismatch'; END IF;
    NEW.source_hash := md5(source_body);
    NEW.stated_by := source_author;
  END IF;
  IF NEW.source_run_id IS NOT NULL THEN
    SELECT session_id INTO STRICT source_room FROM agent_runs WHERE id = NEW.source_run_id;
    IF source_room <> NEW.room_id THEN RAISE EXCEPTION 'Memory source room mismatch'; END IF;
  END IF;
  IF NEW.source_turn_id IS NOT NULL THEN
    SELECT r.session_id, t.driver_user_id INTO STRICT source_room, source_author
      FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id
      WHERE t.id = NEW.source_turn_id AND (NEW.source_run_id IS NULL OR t.run_id = NEW.source_run_id);
    IF source_room <> NEW.room_id THEN RAISE EXCEPTION 'Memory source room mismatch'; END IF;
    IF NEW.speaker = 'mixed' OR (NEW.source_agent_message_id IS NULL AND NEW.source_message_id IS NULL) THEN NEW.stated_by := source_author; END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memory_records WHERE id = NEW.parent_id AND room_id = NEW.room_id
      AND source_hash IS NOT DISTINCT FROM NEW.source_hash
  ) THEN RAISE EXCEPTION 'Memory parent room mismatch'; END IF;
  IF NEW.supersedes IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memory_records WHERE id = NEW.supersedes AND room_id = NEW.room_id
  ) THEN RAISE EXCEPTION 'Memory supersession room mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_source BEFORE INSERT ON memory_records
  FOR EACH ROW EXECUTE FUNCTION validate_memory_source();

CREATE TABLE memory_events (
  id uuid PRIMARY KEY DEFAULT new_id(),
  memory_id uuid NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  actor_id uuid REFERENCES users(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_events_history ON memory_events(memory_id, created_at);

-- Typed edges have real foreign keys where possible. Git targets are checked
-- against a completed turn by the write API, rather than trusting a pasted SHA.
CREATE TABLE memory_edges (
  id uuid PRIMARY KEY DEFAULT new_id(),
  from_id uuid NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('supersedes', 'supports', 'contradicts', 'discussed_in', 'implemented_by', 'mentions_file')),
  to_memory_id uuid REFERENCES memory_records(id) ON DELETE CASCADE,
  to_message_id uuid REFERENCES session_messages(id) ON DELETE CASCADE,
  to_turn_id uuid REFERENCES agent_turns(id) ON DELETE CASCADE,
  repo_ref text,
  commit_sha text,
  path text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_id IS DISTINCT FROM to_memory_id),
  CHECK (
    (relation IN ('supersedes', 'supports', 'contradicts') AND to_memory_id IS NOT NULL AND num_nonnulls(to_message_id, to_turn_id, repo_ref, commit_sha, path) = 0)
    OR (relation = 'discussed_in' AND to_message_id IS NOT NULL AND num_nonnulls(to_memory_id, to_turn_id, repo_ref, commit_sha, path) = 0)
    OR (relation IN ('implemented_by', 'mentions_file') AND to_turn_id IS NOT NULL AND repo_ref IS NOT NULL
        AND commit_sha ~ '^[0-9a-f]{40,64}$' AND to_memory_id IS NULL AND to_message_id IS NULL
        AND (relation <> 'mentions_file' OR path IS NOT NULL))
  ),
  UNIQUE NULLS NOT DISTINCT (from_id, relation, to_memory_id, to_message_id, to_turn_id, repo_ref, commit_sha, path)
);
CREATE INDEX memory_edges_target ON memory_edges(to_memory_id);
CREATE UNIQUE INDEX memory_one_replacement ON memory_edges(to_memory_id) WHERE relation='supersedes';

CREATE TABLE memory_jobs (
  memory_id uuid NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('index', 'extract', 'publish')),
  revision integer NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  last_error text,
  PRIMARY KEY (memory_id, operation)
);
CREATE INDEX memory_jobs_due ON memory_jobs(retry_at);

-- Recheck evidence on every read. An edited source invalidates the derived
-- snapshot; deleting evidence cascades instead of leaving an unscoped copy.
CREATE FUNCTION memory_source_live(memory memory_records) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT
    (memory.source_message_id IS NULL OR EXISTS (SELECT 1 FROM session_messages m
      WHERE m.id = memory.source_message_id AND m.deleted_at IS NULL AND md5(m.body) = memory.source_hash))
    AND (memory.source_agent_message_id IS NULL OR EXISTS (SELECT 1 FROM agent_run_messages m
      WHERE m.id = memory.source_agent_message_id AND md5(m.body) = memory.source_hash))
    AND (memory.source_turn_id IS NULL OR EXISTS (SELECT 1 FROM agent_turns t
      WHERE t.id = memory.source_turn_id AND t.status = 'completed'))
$$;

CREATE FUNCTION validate_memory_edge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room text;
BEGIN
  SELECT room_id INTO STRICT room FROM memory_records WHERE id = NEW.from_id;
  IF NEW.to_memory_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memory_records WHERE id = NEW.to_memory_id AND room_id = room
  ) THEN RAISE EXCEPTION 'Memory edge room mismatch'; END IF;
  IF NEW.to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM session_messages WHERE id = NEW.to_message_id AND session_id = room AND deleted_at IS NULL
  ) THEN RAISE EXCEPTION 'Memory edge source mismatch'; END IF;
  IF NEW.to_turn_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id
    WHERE t.id = NEW.to_turn_id AND r.session_id = room AND t.status = 'completed'
      AND t.result->>'headSha' = NEW.commit_sha AND COALESCE(r.repo_id, r.session_id) = NEW.repo_ref
      AND (NEW.path IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(t.result->'changes') c WHERE c->>'path' = NEW.path
      ))
  ) THEN RAISE EXCEPTION 'Memory edge is not supported by a completed turn'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memory_edge_source BEFORE INSERT OR UPDATE ON memory_edges
  FOR EACH ROW EXECUTE FUNCTION validate_memory_edge();

-- Recover evidence from saved completions, without guessing which transcript
-- message belonged to which historical turn. Project code waits for an exact
-- ancestry proof in the publication worker, including previously published work.
INSERT INTO memory_records(room_id,kind,text,status,stated_by,speaker,stated_at,
  source_run_id,source_turn_id,repo_ref,commit_sha,publish_gated,dedupe_key,approved_at)
SELECT r.session_id,'episode',left('User: ' || COALESCE(t.completion->>'userPrompt','') ||
  E'\nAgent: ' || COALESCE(t.completion->>'output',''),20000),
  CASE WHEN s.project_id IS NOT NULL AND r.repo_id IS NULL AND t.result->>'headSha' IS NOT NULL THEN 'proposed' ELSE 'approved' END,
  t.driver_user_id,'mixed',t.created_at,r.id,t.id,COALESCE(r.repo_id,r.session_id),t.result->>'headSha',
  s.project_id IS NOT NULL AND r.repo_id IS NULL AND t.result->>'headSha' IS NOT NULL,'turn:' || t.id,
  CASE WHEN s.project_id IS NOT NULL AND r.repo_id IS NULL AND t.result->>'headSha' IS NOT NULL THEN NULL ELSE t.ended_at END
FROM agent_turns t JOIN agent_runs r ON r.id=t.run_id JOIN sessions s ON s.id=r.session_id
WHERE t.status='completed' AND t.completion IS NOT NULL
  AND (t.result->>'headSha' IS NULL OR t.result->>'headSha' ~ '^[0-9a-f]{40,64}$');
INSERT INTO memory_edges(from_id,relation,to_turn_id,repo_ref,commit_sha)
SELECT id,'implemented_by',source_turn_id,repo_ref,commit_sha FROM memory_records WHERE commit_sha IS NOT NULL;
INSERT INTO memory_jobs(memory_id,operation,revision)
SELECT id,'extract',revision FROM memory_records
UNION ALL SELECT id,'index',revision FROM memory_records WHERE status='approved'
UNION ALL SELECT id,'publish',revision FROM memory_records WHERE publish_gated;

-- Preserve old pending exchanges without guessing a historical turn or SHA.
-- They remain gated proposals: without a source SHA, publication cannot safely
-- approve them. Reviewers can retract duplicates or create a newly sourced fact.
-- Legacy sidecar
-- entries have no verifiable IDs and are deliberately not trusted on retrieval.
INSERT INTO memory_records(id, room_id, kind, text, source_run_id, dedupe_key, stated_at, stated_by, speaker, publish_gated)
SELECT e.id, e.session_id, 'episode', left('User: ' || e.prompt || E'\nAgent: ' || e.reply, 20000),
       e.run_id, 'legacy:' || e.id, e.created_at, r.started_by, 'mixed', true
FROM staged_memory_exchanges e JOIN agent_runs r ON r.id = e.run_id;
INSERT INTO memory_events(memory_id, to_status, reason)
SELECT id, status, CASE WHEN dedupe_key LIKE 'legacy:%' THEN 'Migrated unpublished exchange; missing source commit, retained for review only'
  ELSE 'Recovered from durable turn completion' END FROM memory_records;
-- Keep the legacy table for rollback/audit; new writes use memory_records.
