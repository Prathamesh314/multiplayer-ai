import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

const TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

export async function listMigrations() {
  const files = await readdir(MIGRATIONS_DIR);
  return files.filter((name) => name.endsWith(".sql")).sort();
}

/**
 * Applies every migration that has not run yet.
 *
 * `db` is anything with `exec(sql)` and `query(sql, params)` — both a pg client
 * and a PGlite instance satisfy it, which is what lets the same migrations run
 * against the real server and the in-process one used by the tests.
 */
export async function migrate(db, { log = () => {} } = {}) {
  await db.exec(TRACKING_TABLE);

  const applied = new Set(
    (await db.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
  );

  const pending = (await listMigrations()).filter((name) => !applied.has(name));
  if (pending.length === 0) {
    log("no pending migrations");
    return [];
  }

  for (const name of pending) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    // Each migration is one transaction: a failure half way through leaves
    // nothing behind to clean up by hand.
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [name]);
      await db.exec("COMMIT");
      log(`applied ${name}`);
    } catch (cause) {
      await db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${cause.message}`, { cause });
    }
  }

  return pending;
}

// Run directly against DATABASE_URL: `node db/migrate.mjs`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // This CLI runs outside Next.js, so it must load the app's .env files itself.
  // Resolve from the script so direct invocation also works from another cwd.
  // Keep this inside the CLI guard: importing migrate() in tests must not load
  // local credentials or override the caller's isolated test configuration.
  const { default: nextEnv } = await import("@next/env");
  nextEnv.loadEnvConfig(dirname(dirname(fileURLToPath(import.meta.url))), process.env.NODE_ENV !== "production");

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Add it to .env or .env.local, or export it in your shell.");
    process.exit(1);
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  // pg's Client has query() but not exec(); the shim keeps migrate() uniform.
  const db = { query: (sql, params) => client.query(sql, params), exec: (sql) => client.query(sql) };

  try {
    const applied = await migrate(db, { log: (m) => console.log(m) });
    console.log(applied.length > 0 ? `${applied.length} migration(s) applied` : "up to date");
  } finally {
    await client.end();
  }
}
