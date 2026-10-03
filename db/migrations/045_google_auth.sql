-- Only short-lived OAuth state is stored here, never Google access/refresh tokens.
CREATE TABLE google_desktop_signins (
  id uuid PRIMARY KEY DEFAULT new_id(),
  challenge text NOT NULL CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE INDEX google_desktop_signins_expiry_idx ON google_desktop_signins(expires_at);

CREATE TABLE google_auth_flows (
  token_hash bytea PRIMARY KEY,
  state_hash bytea NOT NULL UNIQUE,
  nonce_hash bytea NOT NULL,
  code_verifier text,
  invitation_hash bytea,
  return_path text NOT NULL,
  desktop_id uuid REFERENCES google_desktop_signins(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'pending' CHECK (stage IN ('pending','exchanging','verified')),
  google_subject text,
  email citext,
  display_name text,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  CHECK (stage <> 'verified' OR (google_subject IS NOT NULL AND email IS NOT NULL))
);
CREATE INDEX google_auth_flows_expiry_idx ON google_auth_flows(expires_at);
