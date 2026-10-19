-- Platform administrators: operators of this deployment, separate from the
-- people who use it. They sign in with their own email and password at
-- /admin/login (not Clerk), and can read platform-wide statistics. Nothing here
-- grants access to any organisation, room or chat.

CREATE TABLE platform_admins (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                citext NOT NULL UNIQUE,
  display_name         text NOT NULL,
  -- scrypt, as app/lib/auth/password.ts writes it.
  password_hash        text NOT NULL,
  -- Set for a password someone else chose; the first sign-in must replace it.
  must_change_password boolean NOT NULL DEFAULT true,
  failed_attempts      integer NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  disabled_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  password_changed_at  timestamptz
);

CREATE TABLE platform_admin_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  -- SHA-256 of the cookie value; the value itself is never stored.
  token_hash   bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE INDEX platform_admin_sessions_admin ON platform_admin_sessions (admin_id) WHERE revoked_at IS NULL;

-- Sign-ins, failures, sign-outs and password changes, shown on the dashboard.
CREATE TABLE platform_admin_events (
  id         bigserial PRIMARY KEY,
  admin_id   uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  email      citext,
  action     text NOT NULL CHECK (action IN ('login', 'login_failed', 'locked', 'logout', 'password_changed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_admin_events_recent ON platform_admin_events (created_at DESC);

-- The first administrator. Its password was generated once and handed to the
-- owner; it must be changed at first sign-in, after which this hash is unused.
INSERT INTO platform_admins (email, display_name, password_hash, must_change_password)
VALUES ('admin@multicode.ai', 'Administrator', 'scrypt$16384$8$1$WAJnxG7LcWRy4Kwj1yYA9A==$lXE8jmmL1cH8siqN+zyfp3JjPyZMf3/OpHiS+7bxjRBgOF7WmXZIS7pyAeJ5QfWCNmBrjzwrgijYA8HOTB6ygg==', true)
ON CONFLICT (email) DO NOTHING;
