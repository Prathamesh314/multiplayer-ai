-- Files attached to an AI chat message. The bytes live in the object store
-- (attachments/<id>); the member's computer downloads them into the chat's
-- worktree, where the agent reads them with its own tools. Nothing is pasted
-- into the prompt, so the prompt's size no longer limits what can be attached.
--
-- A row is created when the browser asks to upload, with the declared size
-- and a one-time upload token (stored hashed). The bytes then stream to a route
-- outside the Next proxy, which would otherwise buffer and truncate them; it
-- records sha256 and uploaded_at. The attachment is bound to the turn that
-- sends it. Unsent uploads (including those whose chat was deleted) are
-- removed after a day by the worker.
--
-- Runners that predate attachments never claim a turn that has them.
-- Additive with defaults, so the previous release ignores all of it.
CREATE TABLE chat_attachments (
  id uuid PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  size bigint NOT NULL CHECK (size >= 0),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  upload_token_hash bytea UNIQUE,
  uploaded_at timestamptz,
  turn_id uuid REFERENCES agent_turns(id) ON DELETE SET NULL,
  message_id uuid REFERENCES agent_run_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((uploaded_at IS NULL) = (sha256 IS NULL)),
  CHECK (turn_id IS NULL OR uploaded_at IS NOT NULL)
);
CREATE INDEX chat_attachments_session ON chat_attachments(session_id);
CREATE INDEX chat_attachments_message ON chat_attachments(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX chat_attachments_unsent ON chat_attachments(created_at) WHERE turn_id IS NULL;

ALTER TABLE runner_devices
  ADD COLUMN supports_attachments boolean NOT NULL DEFAULT false;

-- The object store cannot be listed, so a deleted attachment (an unsent upload
-- expiring, or its room being deleted) queues its object here for the worker
-- to remove. Nothing else deletes attachment objects.
CREATE TABLE chat_attachment_deletions (
  id uuid PRIMARY KEY,
  queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION queue_chat_attachment_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chat_attachment_deletions(id) VALUES (OLD.id) ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER chat_attachments_deleted AFTER DELETE ON chat_attachments
  FOR EACH ROW EXECUTE FUNCTION queue_chat_attachment_deletion();
