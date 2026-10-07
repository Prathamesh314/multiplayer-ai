-- One browser-bound verification challenge and delivery budget per account.
-- Neither the email code nor the browser secret is stored in plaintext.
CREATE TABLE email_verifications (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email citext NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  token_expires_at timestamptz NOT NULL,
  code_expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  resend_after timestamptz NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  send_count integer NOT NULL CHECK (send_count BETWEEN 1 AND 5),
  delivery_id uuid NOT NULL,
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed'))
);
