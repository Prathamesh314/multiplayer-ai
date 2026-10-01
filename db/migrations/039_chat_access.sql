-- One access rule for chat reads, writes and live streams. Explicit channel
-- membership never overrides suspension, org removal or account deletion.
CREATE FUNCTION conversation_access_role(conversation uuid, actor uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN cm.user_id IS NOT NULL THEN cm.role ELSE 'public' END
    FROM conversations c
    JOIN orgs o ON o.id = c.org_id AND o.deleted_at IS NULL
    JOIN org_members om ON om.org_id = c.org_id AND om.user_id = actor AND om.status = 'active'
    JOIN users u ON u.id = om.user_id AND u.deleted_at IS NULL
    LEFT JOIN conversation_members cm ON cm.conversation_id = c.id
      AND cm.user_id = actor AND cm.removed_at IS NULL
   WHERE c.id = conversation AND c.deleted_at IS NULL
     AND (cm.user_id IS NOT NULL OR (c.kind = 'channel' AND c.visibility = 'public'))
$$;
