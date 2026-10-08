-- Clerk owns credentials and sessions. Preserve UUIDs and all existing access.
ALTER TABLE users ADD COLUMN clerk_user_id text UNIQUE;
ALTER TABLE users ADD COLUMN clerk_updated_at bigint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN clerk_disabled_at timestamptz;

-- A deletion can arrive before first-login provisioning finishes. Keep an
-- identity tombstone even when no local user row exists yet.
CREATE TABLE clerk_deleted_users (
  clerk_user_id text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

-- Short-lived browser approval for the desktop's separate cookie jar. These
-- records authorize a Clerk sign-in ticket; they are not application sessions.
CREATE TABLE clerk_desktop_signins (
  id uuid PRIMARY KEY DEFAULT new_id(),
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  clerk_user_id text,
  approved_session_id text,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  approved_at timestamptz,
  consumed_at timestamptz
);
CREATE INDEX clerk_desktop_signins_expiry_idx ON clerk_desktop_signins(expires_at);

-- JWTs are short-lived; this also closes open streams immediately on logout or
-- a verified Clerk session revocation webhook, without a provider call per event.
CREATE TABLE clerk_revoked_sessions (
  session_id text PRIMARY KEY,
  revoked_at timestamptz NOT NULL DEFAULT now()
);
