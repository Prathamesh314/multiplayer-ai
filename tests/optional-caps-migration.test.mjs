// Migration 054 makes concurrency caps opt-in: it clears only the old default
// values, keeps caps an operator chose, and leaves new orgs uncapped. Runs the
// real migration runner against PGlite, stopping just before 054 to seed data.
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { migrate } from "../db/migrate.mjs";

const MIGRATION = "054_optional_concurrency_caps.sql";
const db = await PGlite.create({ extensions: { citext, vector } });
try {
  // Hold 054 back so the data it migrates can be created first.
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [MIGRATION]);
  await migrate(db);
  const user = (await db.query(`INSERT INTO users(handle,email,display_name,connect_code)
    VALUES ('owner','owner@example.test','Owner','PK-AAAA-AAAA') RETURNING id`)).rows[0].id;
  const org = async (slug, values = {}) => (await db.query(
    `INSERT INTO orgs(slug,name,created_by${values.limit !== undefined ? ",run_concurrency_limit,parallel_chats_per_user" : ""})
     VALUES ($1,$2,$3${values.limit !== undefined ? ",$4,$5" : ""}) RETURNING id`,
    [slug, slug, user, ...(values.limit !== undefined ? [values.limit, values.parallel] : [])])).rows[0].id;
  const untouched = await org("untouched");
  const chosen = await org("chosen", { limit: 7, parallel: 2 });
  const before = (await db.query("SELECT run_concurrency_limit, parallel_chats_per_user FROM orgs WHERE id = $1", [untouched])).rows[0];
  assert.deepEqual(before, { run_concurrency_limit: 3, parallel_chats_per_user: 4 }, "before 054 every org got the old defaults");

  await db.query("DELETE FROM schema_migrations WHERE version = $1", [MIGRATION]);
  assert.deepEqual(await migrate(db), [MIGRATION]);

  const caps = async id => (await db.query("SELECT run_concurrency_limit, parallel_chats_per_user FROM orgs WHERE id = $1", [id])).rows[0];
  assert.deepEqual(await caps(untouched), { run_concurrency_limit: null, parallel_chats_per_user: null }, "old defaults are cleared");
  assert.deepEqual(await caps(chosen), { run_concurrency_limit: 7, parallel_chats_per_user: 2 }, "an operator's chosen caps are kept");
  assert.deepEqual(await caps(await org("fresh")), { run_concurrency_limit: null, parallel_chats_per_user: null }, "new orgs start uncapped");
  await assert.rejects(db.query("UPDATE orgs SET run_concurrency_limit = -1 WHERE id = $1", [chosen]), /check constraint/);
  await assert.rejects(db.query("UPDATE orgs SET parallel_chats_per_user = 0 WHERE id = $1", [chosen]), /check constraint/);
  console.log("Optional caps migration: old defaults cleared, chosen caps kept, new orgs uncapped, constraints intact.");
} finally {
  await db.close();
}
