/*
 * Session chat.
 *
 * Durable, unlike presence and typing markers: a conversation about the code is
 * part of the record of how it got that way, and someone joining tomorrow
 * should be able to read it.
 *
 * Delivery is still through the event bus — this table is the history, not the
 * transport.
 */
CREATE TABLE session_messages (
  id         uuid PRIMARY KEY DEFAULT new_id(),
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- Kept when the account is deleted, so a thread does not lose half its turns.
  -- Deleting a person is a separate decision from erasing what they said.
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  deleted_at timestamptz,

  CONSTRAINT session_messages_body_present CHECK (length(btrim(body)) > 0),
  CONSTRAINT session_messages_body_length CHECK (length(body) <= 4000)
);

/*
 * Chat is read newest-first and almost never in full, so the index is ordered
 * to match: this serves both "the last 50" and "the 50 before that" without a
 * sort.
 */
CREATE INDEX session_messages_recent_idx
  ON session_messages (session_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
