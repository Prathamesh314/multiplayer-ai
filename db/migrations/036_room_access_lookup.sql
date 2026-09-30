-- Read each membership once. Preserve the existing revocation and viewer
-- precedence rules without repeating correlated membership subqueries.
CREATE OR REPLACE FUNCTION room_access_role(room_id text, actor_id uuid) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN u.id IS NULL THEN NULL
    WHEN s.org_id IS NOT NULL AND (om.user_id IS NULL OR om.status <> 'active') THEN NULL
    WHEN s.project_id IS NOT NULL AND pm.removed_at IS NOT NULL THEN NULL
    WHEN pm.role = 'viewer' AND (s.visibility = 'public' OR sm.user_id IS NOT NULL) THEN 'viewer'
    ELSE COALESCE(
      sm.role,
      CASE WHEN s.visibility = 'public' THEN COALESCE(
        CASE pm.role WHEN 'manager' THEN 'editor' ELSE pm.role END,
        CASE WHEN om.status = 'active' AND om.role IN ('owner', 'admin') THEN 'editor' END
      ) END
    ) END
  FROM sessions s
  LEFT JOIN users u ON u.id = actor_id AND u.deleted_at IS NULL
  LEFT JOIN org_members om ON om.org_id = s.org_id AND om.user_id = actor_id
  LEFT JOIN project_members pm ON pm.project_id = s.project_id AND pm.user_id = actor_id
  LEFT JOIN session_members sm ON sm.session_id = s.id AND sm.user_id = actor_id AND sm.removed_at IS NULL
  WHERE s.id = room_id AND s.deleted_at IS NULL
$$;
