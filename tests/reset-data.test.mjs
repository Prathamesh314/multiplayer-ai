/**
 * The data reset. Destructive maintenance, so the guards matter as much as the
 * effect: it must refuse without the database name, keep the migration ledger,
 * and put back the singleton row that nothing else recreates.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../db/migrate.mjs";

const exec = promisify(execFile);
const admin = process.env.DATABASE_URL;
if (!admin) throw new Error("DATABASE_URL is required for this test.");

const name = `reset_test_${randomUUID().replaceAll("-", "")}`;
const root = new pg.Pool({ connectionString: admin });
await root.query(`CREATE DATABASE ${name}`);
const url = new URL(admin);
url.pathname = `/${name}`;
const db = new pg.Pool({ connectionString: url.toString() });
const run = (...args) =>
  exec(process.execPath, ["scripts/reset-data.mjs", ...args], { env: { ...process.env, DATABASE_URL: url.toString() } })
    .then(result => ({ code: 0, ...result }))
    .catch(cause => ({ code: cause.code, stdout: cause.stdout ?? "", stderr: cause.stderr ?? "" }));
const count = async table => Number((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

try {
  await migrate({ query: (sql, params) => db.query(sql, params), exec: sql => db.query(sql) });
  const seed = async () => {
    await db.query(`INSERT INTO users(handle,email,display_name,connect_code)
      VALUES ('alice','alice@reset.test','Alice','PK-AAAA-AAAA') ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO orgs(slug,name,created_by)
      SELECT 'reset','Reset',id FROM users WHERE handle='alice' ON CONFLICT DO NOTHING`);
  };
  await seed();

  await test("without the database name it reports and changes nothing", async () => {
    const before = await count("users");
    assert.ok(before > 0, "fixture should have seeded a user");

    for (const args of [[], ["--confirm"], ["--confirm", "wrong_name"]]) {
      const result = await run(...args);
      assert.equal(result.code, 1, `should refuse: ${JSON.stringify(args)}`);
      assert.match(result.stdout, /Nothing was changed/);
      assert.equal(await count("users"), before, "rows must survive a refusal");
    }
    // The refusal still shows what is at stake.
    assert.match((await run()).stdout, /users\s+\d+/);
  });

  await test("naming the database empties the data and keeps the schema", async () => {
    await seed();
    const tables = Number((await db.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'`)).rows[0].n);
    const migrations = await count("schema_migrations");
    assert.ok(migrations > 0);

    const result = await run("--confirm", name);
    assert.equal(result.code, 0, result.stderr);

    assert.equal(await count("users"), 0);
    assert.equal(await count("orgs"), 0);
    // The schema itself is untouched — this empties, it does not drop.
    assert.equal(Number((await db.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'`)).rows[0].n), tables);
    // Replaying every migration against an already-migrated schema would fail,
    // so the ledger has to survive.
    assert.equal(await count("schema_migrations"), migrations);
    // Seeded by migration 049 and only ever UPDATEd afterwards; without this,
    // storage accounting silently updates zero rows for ever.
    assert.equal(await count("storage_capacity"), 1);
  });

  await test("a second run is harmless and reports an empty database", async () => {
    const result = await run("--confirm", name);
    assert.equal(result.code, 0, result.stderr);
    // The restored singleton is bookkeeping, not data at stake: an already
    // reset deployment must not look populated because of it.
    assert.match(result.stdout, /already empty/);
    assert.doesNotMatch(result.stdout, /storage_capacity\s+\d/);
    assert.equal(await count("storage_capacity"), 1);
  });

  await test("counts are exact, not stale planner estimates", async () => {
    await seed();
    // pg_stat_user_tables still reports the pre-truncate shape until autovacuum
    // catches up, so a tool that trusted it would misreport what is at risk.
    const { rows: [stat] } = await db.query(
      `SELECT coalesce(sum(n_live_tup),0)::int AS n FROM pg_stat_user_tables
        WHERE schemaname='public' AND relname IN ('users','orgs')`);
    const shown = (await run()).stdout;
    assert.match(shown, /users\s+1/, `exact count expected; stats said ${stat.n}`);
    assert.match(shown, /orgs\s+1/);
    await run("--confirm", name);
  });
} finally {
  await db.end();
  await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await root.end();
}
