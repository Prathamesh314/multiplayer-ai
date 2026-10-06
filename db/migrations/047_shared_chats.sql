-- Chat invitations deliberately grant no organisation, project or room access.
CREATE TABLE chat_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  email citext NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'commenter')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL))
);
CREATE INDEX chat_invitations_run ON chat_invitations(run_id, created_at DESC);
CREATE UNIQUE INDEX chat_invitations_one_live_recipient ON chat_invitations(run_id,email) WHERE revoked_at IS NULL;
CREATE INDEX chat_invitations_recipient ON chat_invitations(accepted_by, run_id) WHERE revoked_at IS NULL;

CREATE TABLE shared_chat_comments (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 8000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shared_chat_comments_history ON shared_chat_comments(run_id, created_at, id);

-- Org membership is physically deleted on removal. Retain a denial so absence
-- cannot be mistaken for a brand-new external guest. Rejoining clears it.
CREATE TABLE chat_guest_blocks (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(org_id,user_id)
);

-- Both access and acceptance use these checks. A guest grant cannot bypass a
-- suspension, project removal, account deletion, or a departed invitation owner.
CREATE FUNCTION chat_guest_eligible(chat uuid, actor uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM agent_runs r JOIN sessions s ON s.id=r.session_id
    JOIN users u ON u.id=actor AND u.deleted_at IS NULL
    LEFT JOIN orgs o ON o.id=s.org_id
    LEFT JOIN org_members om ON om.org_id=s.org_id AND om.user_id=actor
    LEFT JOIN project_members pm ON pm.project_id=s.project_id AND pm.user_id=actor
    LEFT JOIN projects p ON p.id=s.project_id
    WHERE r.id=chat AND s.deleted_at IS NULL
      AND (s.org_id IS NULL OR o.deleted_at IS NULL)
      AND (s.project_id IS NULL OR p.archived_at IS NULL)
      AND (om.user_id IS NULL OR om.status='active')
      AND (pm.user_id IS NULL OR pm.removed_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM chat_guest_blocks b WHERE b.org_id=s.org_id AND b.user_id=actor)
  )
$$;

CREATE FUNCTION chat_share_issuer_active(chat uuid, actor uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM agent_runs r JOIN sessions s ON s.id=r.session_id
    WHERE r.id=chat AND chat_guest_eligible(chat, actor)
      AND room_access_role(s.id,actor) IN ('owner','editor')
  )
$$;

CREATE FUNCTION chat_share_manager(chat uuid, actor uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM agent_runs r JOIN sessions s ON s.id=r.session_id
    WHERE r.id=chat AND chat_share_issuer_active(chat,actor)
      AND (s.owner_id=actor OR r.driver_user_id=actor)
  )
$$;

CREATE FUNCTION shared_chat_role(chat uuid, actor uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN chat_share_manager(chat,actor) THEN 'manager'
    ELSE (SELECT i.role FROM chat_invitations i JOIN users u ON u.id=actor AND u.email=i.email AND u.email_verified_at IS NOT NULL
      WHERE i.run_id=chat AND i.accepted_by=actor AND i.revoked_at IS NULL AND i.expires_at>now()
        AND chat_share_issuer_active(chat,i.created_by)
      ORDER BY (i.role='commenter') DESC LIMIT 1) END
  WHERE chat_guest_eligible(chat,actor)
$$;

-- Removing an org member must not turn them into an outsider who can reuse an
-- old guest invitation. Invalidate both issued and received grants atomically.
CREATE FUNCTION revoke_removed_member_chat_invitations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.status='active' THEN
    DELETE FROM chat_guest_blocks WHERE org_id=NEW.org_id AND user_id=NEW.user_id;
  ELSE
    INSERT INTO chat_guest_blocks(org_id,user_id)
      SELECT o.id,u.id FROM orgs o,users u WHERE o.id=OLD.org_id AND u.id=OLD.user_id
      ON CONFLICT DO NOTHING;
    UPDATE chat_invitations i SET revoked_at=COALESCE(i.revoked_at,now())
    FROM agent_runs r, sessions s, users u
    WHERE i.run_id=r.id AND r.session_id=s.id AND s.org_id=OLD.org_id
      AND u.id=OLD.user_id AND (i.created_by=u.id OR i.accepted_by=u.id OR i.email=u.email)
      AND i.revoked_at IS NULL;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER revoke_member_chat_invitations AFTER INSERT OR DELETE OR UPDATE OF status ON org_members
FOR EACH ROW EXECUTE FUNCTION revoke_removed_member_chat_invitations();
