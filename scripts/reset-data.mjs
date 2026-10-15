/**
 * Empty every application table, keeping the schema exactly as it is.
 *
 * For starting a deployment over — a new domain, a finished beta — without
 * dropping and rebuilding the database. The schema, indexes, constraints and
 * functions are untouched; only rows go.
 *
 * Two things a plain `TRUNCATE` over every table gets wrong, and this does not:
 *
 *  - `schema_migrations` must survive. Empty it and the next deploy replays all
 *    migrations against a schema that already has them applied, which fails
 *    partway and leaves the database in a state no rollback understands.
 *  - `storage_capacity` is a singleton seeded by migration 049 and only ever
 *    UPDATEd (`WHERE id = 1`) afterwards. Truncate it and nothing recreates it:
 *    storage accounting then silently updates zero rows for ever.
 *
 * This clears Postgres only. The repositories under MULTIPLAYER_AI_DATA and the
 * mnemosyne sidecar are separate stores — see docs/reset-deployment.md, which is
 * the procedure this script is one step of. Clearing one without the others
 * leaves orphaned Git history and memory with no rows pointing at it.
 */
import pg from "pg";

const KEEP = new Set(["schema_migrations"]);
/** Seeded by a migration, never re-inserted by the application. */
const SINGLETONS = [{ table: "storage_capacity", sql: "INSERT INTO storage_capacity(id) VALUES (1) ON CONFLICT DO NOTHING" }];

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required.");
const expected = new URL(url).pathname.replace(/^\//, "");
const confirm = process.argv.indexOf("--confirm");
const supplied = confirm === -1 ? null : process.argv[confirm + 1];

/** Table names come from pg_tables, but quote them anyway rather than trust it. */
const quote = (name) => name.replaceAll('"', '""');

const pool = new pg.Pool({ connectionString: url });
try {
  const { rows: tables } = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const targets = tables.map((row) => row.tablename).filter((name) => !KEEP.has(name));
  if (targets.length === 0) throw new Error("No application tables found — is this the right database?");

  // Exact counts, not pg_stat_user_tables: that is a planner estimate which
  // lags until autovacuum runs, so it will happily report rows in a table that
  // was just emptied, or none in one that is full. Telling someone what they
  // are about to destroy is the whole point of this output, so it pays for the
  // scan.
  const { rows: counts } = await pool.query(
    targets.map((name) => `SELECT '${name}' AS relname, count(*)::bigint AS rows FROM public."${quote(name)}"`)
      .join(" UNION ALL ") + " ORDER BY rows DESC, relname",
  );
  // Singletons are truncated and immediately put back, so they are not data at
  // stake; listing them would make an already-reset deployment look populated.
  const restored = new Set(SINGLETONS.map((singleton) => singleton.table));
  const populated = counts.filter((row) => Number(row.rows) > 0 && !restored.has(row.relname));

  console.log(`Database : ${expected}`);
  console.log(`Tables   : ${targets.length} to empty, ${KEEP.size} preserved (${[...KEEP].join(", ")})`);
  if (populated.length === 0) console.log("Rows     : already empty");
  else {
    const total = populated.reduce((sum, row) => sum + Number(row.rows), 0);
    console.log(`Rows     : ${total} across ${populated.length} tables`);
    for (const row of populated) console.log(`           ${row.relname.padEnd(32)} ${row.rows}`);
  }

  if (supplied !== expected) {
    console.log(`\nNothing was changed. This is irreversible, so it runs only when you name the database:\n`);
    console.log(`    DATABASE_URL=… node scripts/reset-data.mjs --confirm ${expected}\n`);
    console.log("Take a backup first — see docs/reset-deployment.md.");
    process.exitCode = 1;
  } else {
    // One statement: CASCADE plus a single transaction means foreign keys never
    // have to be dropped, and the order of the tables does not matter.
    const list = targets.map((name) => `public."${quote(name)}"`).join(", ");
    await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    for (const singleton of SINGLETONS) await pool.query(singleton.sql);
    console.log(`\nEmptied ${targets.length} tables. Restored ${SINGLETONS.map((s) => s.table).join(", ")}.`);
    console.log("Schema, indexes and applied migrations are unchanged.");
    console.log("\nNext: clear the other stores and re-bootstrap accounting — docs/reset-deployment.md.");
  }
} finally {
  await pool.end();
}
