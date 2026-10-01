-- Serialize roster mutations before the deferred last-owner constraint runs.
-- Without this, two transactions can each observe the other departing owner.
-- NO KEY UPDATE remains compatible with FK inserts referencing this org.
CREATE FUNCTION serialize_org_roster_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM orgs WHERE id = OLD.org_id FOR NO KEY UPDATE;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER org_members_serialize_change
  BEFORE UPDATE OR DELETE ON org_members
  FOR EACH ROW EXECUTE FUNCTION serialize_org_roster_change();
