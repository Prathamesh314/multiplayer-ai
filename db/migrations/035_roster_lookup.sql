-- Room access is inherited from project membership or organization admins,
-- never from ordinary organization membership alone.
CREATE INDEX org_members_active_admins_idx ON org_members (org_id, user_id)
  WHERE status = 'active' AND role IN ('owner', 'admin');
