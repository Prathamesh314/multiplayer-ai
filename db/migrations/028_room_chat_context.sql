/* Searchable human discussion memory. Keep the source message authoritative:
 * generated vectors backfill history and update atomically on every edit.
 * English stemming finds variants; simple preserves code/product vocabulary.
 * Partial indexes exclude deleted messages, without copying private chat into
 * a shared vector bank that could outlive its access permissions. */
ALTER TABLE session_messages ADD COLUMN search_document tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', body) || to_tsvector('simple', body)
  ) STORED;

CREATE INDEX session_messages_search_idx ON session_messages
  USING gin (search_document) WHERE deleted_at IS NULL;

CREATE INDEX session_messages_author_recent_idx ON session_messages
  (session_id, user_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
