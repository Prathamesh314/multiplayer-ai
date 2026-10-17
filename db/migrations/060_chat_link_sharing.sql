-- Sharing a chat the way documents are shared: add people by email, and
-- optionally let anyone with the link view (or comment on) it.
--
-- People added by email need no invitation link: opening the chat while
-- signed in with that verified email is enough, until the host removes them.
-- Their rows have no token and no expiry. Earlier link invitations keep
-- working as before (token accepted once, then bound to that account).
--
-- "Anyone with the link" is one row per chat. The link carries a random
-- token; turning link sharing off deletes it, and turning it on again makes a
-- new one. It shows only the chat's human and AI messages, never the room,
-- files or tools, and stops working when its creator can no longer share.
--
-- Additive: the previous release keeps issuing and accepting token invitations.
ALTER TABLE chat_invitations ALTER COLUMN token_hash DROP NOT NULL, ALTER COLUMN expires_at DROP NOT NULL;

CREATE TABLE chat_links (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE CHECK (token ~ '^[A-Za-z0-9_-]{43}$'),
  role text NOT NULL CHECK (role IN ('viewer', 'commenter')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION shared_chat_role(chat uuid, actor uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN chat_share_manager(chat,actor) THEN 'manager'
    ELSE (SELECT i.role FROM chat_invitations i JOIN users u ON u.id=actor AND u.email=i.email AND u.email_verified_at IS NOT NULL
      WHERE i.run_id=chat AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at>now())
        AND (i.accepted_by=actor OR (i.token_hash IS NULL AND i.accepted_by IS NULL))
        AND chat_share_issuer_active(chat,i.created_by)
      ORDER BY (i.role='commenter') DESC LIMIT 1) END
  WHERE chat_guest_eligible(chat,actor)
$$;

-- The role a chat link grants, or NULL. Needs no account.
CREATE FUNCTION chat_link_role(chat uuid, link text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT l.role FROM chat_links l
  WHERE l.run_id=chat AND link IS NOT NULL AND l.token=link AND chat_share_issuer_active(chat,l.created_by)
$$;
