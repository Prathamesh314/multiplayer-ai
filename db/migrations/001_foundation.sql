-- Extensions and helpers everything else builds on.

CREATE EXTENSION IF NOT EXISTS citext;

/*
 * Primary keys are time-ordered where the server can manage it: sequential
 * uuids keep B-tree inserts local instead of scattering them across the index,
 * which matters once these tables are large.
 *
 * uuidv7() is Postgres 18+. Older servers silently keep the random v4 default
 * rather than failing the migration.
 */
CREATE OR REPLACE FUNCTION new_id() RETURNS uuid
  LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7') THEN
    EXECUTE 'CREATE OR REPLACE FUNCTION new_id() RETURNS uuid '
            'LANGUAGE sql VOLATILE AS $f$ SELECT uuidv7() $f$';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
