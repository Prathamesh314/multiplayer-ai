-- Invitation secrets are shown once to the operator; only their digest persists.
CREATE TABLE signup_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_by uuid REFERENCES users(id),
  used_at timestamptz,
  revoked_at timestamptz
);
ALTER TABLE org_invitations ADD COLUMN signup_user_id uuid REFERENCES users(id);
