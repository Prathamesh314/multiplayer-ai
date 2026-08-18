/*
 * Two routes into an org — an admin emails you, or you post your connect code
 * and an admin pastes it. One table, because they differ only in how the
 * invitee is identified.
 *
 * Both routes produce a *pending* invitation, never a membership. Sharing a
 * connect code says "you may ask me", not "add me to anything you like";
 * without the acceptance step a leaked code silently drops someone into an org
 * whose sessions they can then read.
 */
CREATE TABLE org_invitations (
  id              uuid PRIMARY KEY DEFAULT new_id(),
  org_id          uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Optional: drop them straight into a team on acceptance.
  team_id         uuid,
  via             text NOT NULL CHECK (via IN ('email', 'connect_code')),
  email           citext,
  invitee_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('admin', 'member')),
  -- Email route only, and hashed like every other secret here.
  token_hash      bytea,
  invited_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Invitations that never expire become a liability.
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by     uuid REFERENCES users(id),
  revoked_at      timestamptz,

  CONSTRAINT org_invitations_one_identification CHECK (
    (via = 'email'        AND email IS NOT NULL AND invitee_user_id IS NULL) OR
    (via = 'connect_code' AND email IS NULL     AND invitee_user_id IS NOT NULL)
  ),
  CONSTRAINT org_invitations_email_needs_token CHECK (
    via <> 'email' OR token_hash IS NOT NULL
  ),
  CONSTRAINT org_invitations_expiry_after_creation CHECK (expires_at > created_at),

  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX org_invitations_token_idx
  ON org_invitations (token_hash) WHERE token_hash IS NOT NULL;

/*
 * One live invitation per person per org. Partial, so a second invitation is
 * allowed once the first was accepted, declined or revoked.
 */
CREATE UNIQUE INDEX org_invitations_live_email_idx
  ON org_invitations (org_id, email)
  WHERE via = 'email' AND accepted_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX org_invitations_live_user_idx
  ON org_invitations (org_id, invitee_user_id)
  WHERE via = 'connect_code' AND accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX org_invitations_pending_for_user_idx
  ON org_invitations (invitee_user_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
