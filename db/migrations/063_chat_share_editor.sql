-- "Editor" when sharing a chat by email: the person can continue the work on
-- their own computer. When they first open the chat, the host's authority
-- makes them an editor of the room (joining the organisation and project if
-- needed), exactly as "Allow guest to help with code" does, recorded in
-- chat_access_grants. They then fork the chat or take it over with a handoff;
-- nobody drives the host's computer. "Anyone with the link" cannot be Editor.
--
-- Additive: the previous release reads an editor as a viewer.
ALTER TABLE chat_invitations DROP CONSTRAINT chat_invitations_role_check;
ALTER TABLE chat_invitations ADD CONSTRAINT chat_invitations_role_check CHECK (role IN ('viewer', 'commenter', 'editor'));

-- As in 060, with editor ranked above commenter.
CREATE OR REPLACE FUNCTION shared_chat_role(chat uuid, actor uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN chat_share_manager(chat,actor) THEN 'manager'
    ELSE (SELECT i.role FROM chat_invitations i JOIN users u ON u.id=actor AND u.email=i.email AND u.email_verified_at IS NOT NULL
      WHERE i.run_id=chat AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at>now())
        AND (i.accepted_by=actor OR (i.token_hash IS NULL AND i.accepted_by IS NULL))
        AND chat_share_issuer_active(chat,i.created_by)
      ORDER BY array_position(ARRAY['editor','commenter','viewer'], i.role) LIMIT 1) END
  WHERE chat_guest_eligible(chat,actor)
$$;
