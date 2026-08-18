/*
 * A share link is a row, not a string the client can shape.
 *
 * The role has to be resolved from the token server-side: if the link carried
 * its own role — "#k=<code>&role=editor" — anyone holding a viewer link could
 * promote themselves by editing the URL. Here the token is the only thing the
 * recipient has, and what it grants is a column.
 *
 * Rows rather than a second column on `sessions` so each link is separately
 * revocable: one leaked editor link should not force everyone else's access to
 * be reissued.
 */
CREATE TABLE session_share_links (
  id           uuid PRIMARY KEY DEFAULT new_id(),
  session_id   text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  -- SHA-256 of the token. The token itself is shown once, at creation, and is
  -- never recoverable from the database afterwards.
  token_hash   bytea NOT NULL UNIQUE,
  -- 'owner' is deliberately absent: a link must never hand over the session.
  role         text NOT NULL CHECK (role IN ('viewer', 'editor')),
  label        text,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Null means it does not expire on its own; revoking is then the only way out.
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  uses         integer NOT NULL DEFAULT 0,

  CONSTRAINT session_share_links_expiry_after_creation
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX session_share_links_live_idx
  ON session_share_links (session_id)
  WHERE revoked_at IS NULL;
