-- Orgs contain teams. A person joins the org first and a team second, and the
-- database is what enforces that ordering.

CREATE TABLE orgs (
  id         uuid PRIMARY KEY DEFAULT new_id(),
  slug       citext NOT NULL UNIQUE,
  name       text NOT NULL,
  image      text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  CONSTRAINT orgs_slug_format
    CHECK (slug::text ~ '^[a-z0-9][a-z0-9-]{1,38}$'),
  -- Slugs share the URL space with the app's own routes.
  CONSTRAINT orgs_slug_not_reserved
    CHECK (slug::text NOT IN ('s', 'api', 'admin', 'settings', 'login', 'signup', 'new', 'static', '_next'))
);

CREATE TRIGGER orgs_touch_updated_at
  BEFORE UPDATE ON orgs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE org_members (
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  -- Suspending keeps history that deleting would destroy.
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  invited_by uuid REFERENCES users(id),
  joined_at  timestamptz NOT NULL DEFAULT now(),

  -- Also the unique target that team_members' composite key points at.
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX org_members_user_id_idx ON org_members (user_id);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT new_id(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  slug       citext NOT NULL,
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  UNIQUE (org_id, slug),
  -- Redundant on its own, and the load-bearing half of the constraint below.
  UNIQUE (id, org_id)
);

CREATE INDEX teams_org_id_idx ON teams (org_id);

/*
 * org_id is carried here on purpose. With it, two composite foreign keys make
 * cross-tenant membership unrepresentable: a row must agree with the team on
 * which org the team belongs to, AND name a user who is already a member of
 * that same org. Neither is a convention the application has to remember.
 *
 * It also means removing someone from an org removes them from every team in
 * it, atomically, with no application code and no half-done window.
 */
CREATE TABLE team_members (
  team_id   uuid NOT NULL,
  org_id    uuid NOT NULL,
  user_id   uuid NOT NULL,
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
  joined_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id, org_id) REFERENCES teams (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id) REFERENCES org_members (org_id, user_id) ON DELETE CASCADE
);

CREATE INDEX team_members_user_id_idx ON team_members (user_id);

/*
 * "At least one owner" is not expressible as a declarative constraint.
 *
 * Deferring to commit is what makes it usable: promoting a new owner and
 * demoting the old one in one transaction passes, while any transaction that
 * ends with zero owners fails.
 */
CREATE OR REPLACE FUNCTION assert_org_has_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid := COALESCE(OLD.org_id, NEW.org_id);
  owners int;
BEGIN
  -- The org may have been deleted in this same transaction, which cascades the
  -- memberships away legitimately.
  IF NOT EXISTS (SELECT 1 FROM orgs WHERE id = target) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO owners
    FROM org_members
   WHERE org_id = target AND role = 'owner' AND status = 'active';

  IF owners = 0 THEN
    RAISE EXCEPTION 'org % would be left without an active owner', target
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER org_members_keep_an_owner
  AFTER UPDATE OR DELETE ON org_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_org_has_owner();
