/*
 * Runner devices: the user's machines that execute agent runs locally.
 *
 * The product's execution model is Conductor's — agents run on the member's
 * own computer, with their own CPU and their own AI logins — while this server
 * stays the control plane (docs/local-execution.md). A *device* is one paired
 * machine: the desktop app's runner daemon dials out, authenticates with a
 * long-lived device token, and receives only jobs addressed to its own user.
 *
 * Tokens follow the auth_tokens discipline exactly: the database stores only
 * the SHA-256, so a dump grants nothing. Pairing is a short-lived, single-use
 * code minted by a signed-in browser session and exchanged once by the runner
 * — the code is the credential for that exchange, which is why it too is
 * stored hashed.
 */

CREATE TABLE runner_devices (
  id           uuid PRIMARY KEY DEFAULT new_id(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- "Prathamesh's MacBook Pro" — chosen at pairing, shown in the devices list.
  name         text NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  platform     text,
  -- Runner build, so the server can refuse versions with known holes.
  version      text,
  -- Heartbeat-maintained; "online" = seen within the liveness window.
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,

  CONSTRAINT runner_devices_name_length CHECK (length(name) BETWEEN 1 AND 100)
);

CREATE INDEX runner_devices_user_idx ON runner_devices (user_id, created_at DESC);

CREATE TABLE runner_pairing_codes (
  code_hash  bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- Single-use: the exchange claims the row by setting this atomically.
  used_at    timestamptz,

  CONSTRAINT runner_pairing_codes_expiry CHECK (expires_at > created_at)
);

/*
 * Where a run executes, and the lease that keeps local execution honest.
 * 'server' is every historical run and the cloud-fallback path; 'local' means
 * a runner claimed it. The lease expires if the device stops heartbeating
 * mid-run, letting a reaper fail the run over instead of leaving it stuck.
 */
ALTER TABLE agent_runs
  ADD COLUMN execution text NOT NULL DEFAULT 'server'
    CHECK (execution IN ('server', 'local')),
  ADD COLUMN assigned_device_id uuid REFERENCES runner_devices(id) ON DELETE SET NULL,
  ADD COLUMN lease_expires_at timestamptz;
