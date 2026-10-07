CREATE TABLE chat_briefings (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  body jsonb NOT NULL,
  sources jsonb NOT NULL,
  source_fingerprint text NOT NULL,
  source_seq bigint NOT NULL,
  head_sha text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  shared_with_guests boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_records_chat_decisions ON memory_records(source_run_id,stated_at DESC,id)
  WHERE kind='fact' AND status='approved';

CREATE TABLE chat_reviews (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  reviewer_id uuid NOT NULL REFERENCES users(id),
  head_sha text NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40,64}$'),
  base_sha text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','changes_requested','cancelled')),
  request_note text NOT NULL DEFAULT '' CHECK (length(request_note)<=4000),
  response_note text NOT NULL DEFAULT '' CHECK (length(response_note)<=4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (requested_by <> reviewer_id),
  CHECK ((status='requested') = (resolved_at IS NULL))
);
CREATE INDEX chat_reviews_run ON chat_reviews(run_id,created_at DESC);
CREATE INDEX chat_reviews_inbox ON chat_reviews(reviewer_id,created_at DESC) WHERE status='requested';
CREATE UNIQUE INDEX chat_reviews_pending ON chat_reviews(run_id,reviewer_id,head_sha) WHERE status='requested';

-- Sequence numbers are serialized by the chat row lock on comment creation.
ALTER TABLE shared_chat_comments ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX shared_chat_comments_sequence ON shared_chat_comments(run_id,seq);
CREATE TABLE chat_feedback_reads (
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(run_id,user_id)
);
CREATE TABLE chat_access_grants (
  invitation_id uuid PRIMARY KEY REFERENCES chat_invitations(id) ON DELETE CASCADE,
  granted_by uuid NOT NULL REFERENCES users(id),
  granted_to uuid NOT NULL REFERENCES users(id),
  scope jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE chat_access_requests (
  invitation_id uuid PRIMARY KEY REFERENCES chat_invitations(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  scope_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined')),
  resolved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX chat_access_requests_pending ON chat_access_requests(created_at,invitation_id) WHERE status='pending';
