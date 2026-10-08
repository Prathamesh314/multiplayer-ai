-- File bytes, not filesystem blocks. Backfill is performed under the owner's
-- initialization lock before its first admission; migrations never walk disk.
CREATE TABLE storage_usage (
  owner text PRIMARY KEY CHECK (owner ~ '^(org|user):[0-9a-f-]{36}$'),
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  initialized boolean NOT NULL DEFAULT false
);
CREATE TABLE storage_resources (
  key text PRIMARY KEY,
  owner text NOT NULL REFERENCES storage_usage(owner),
  bytes bigint NOT NULL CHECK (bytes >= 0),
  anomaly text,
  measured_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX storage_resources_owner ON storage_resources(owner);
CREATE TABLE storage_capacity (
  id integer PRIMARY KEY CHECK (id = 1),
  reserved_bytes bigint NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)
);
INSERT INTO storage_capacity(id) VALUES (1);
-- A row is also a durable dirty marker. Never expire it based on wall time:
-- a stopped process or an orphaned Git child may still own the kernel lock.
CREATE TABLE storage_reservations (
  resource_key text PRIMARY KEY REFERENCES storage_resources(key),
  quota_bytes bigint NOT NULL CHECK (quota_bytes >= 0),
  disk_bytes bigint NOT NULL CHECK (disk_bytes >= 0),
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX storage_reservations_recovery ON storage_reservations(checked_at NULLS FIRST,created_at);
