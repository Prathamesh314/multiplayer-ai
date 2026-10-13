/**
 * Chat naming. Two properties matter more than any particular wording:
 *
 *  - a chat is named exactly once, from the prompt that opened it, and a name
 *    its driver typed is never overwritten;
 *  - drafting is pure, so two tabs racing the same prompt cannot disagree.
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { migrate } from "../db/migrate.mjs";
import { draftRunTitle, refineRunTitle, MAX_TITLE } from "../app/lib/ai/titles.ts";

const db = await PGlite.create({ extensions: { citext, vector } });
// PGlite has one connection, so whole transactions are serialized behind a
// queue the way the shared memory fixture does it.
let waiting = Promise.resolve();
async function acquire() {
  const previous = waiting;
  let release;
  waiting = new Promise((resolve) => { release = resolve; });
  await previous;
  return release;
}
const execute = async (sql, params) => {
  const result = await db.query(sql, params);
  return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
globalThis.__maPool = {
  async query(sql, params) { const release = await acquire(); try { return await execute(sql, params); } finally { release(); } },
  async connect() { const release = await acquire(); return { query: execute, release }; },
};
const { autoRenameRun, createRun, getRun, renameRun } = await import("../app/lib/ai/runs.ts");

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok ${name}`);
}
const first = async (sql, params) => (await db.query(sql, params)).rows[0];

try {
  await migrate(db);
  const alice = (await first(`INSERT INTO users(handle,email,display_name,connect_code)
    VALUES ('alice','alice@test.local','Alice','PK-AAAA-AAAA') RETURNING id`)).id;
  const org = (await first(`INSERT INTO orgs(slug,name,created_by)
    VALUES ('titles','Titles',$1) RETURNING id`, [alice])).id;
  await db.query(`INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'owner')`, [org, alice]);
  const room = (await first(`INSERT INTO sessions(id,owner_id,org_id,name,join_code,visibility)
    VALUES ('titlesroomxx',$1,$2,'Titles','ABCD-EFGH','private') RETURNING id`, [alice, org])).id;
  await db.query(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'owner','owner')`, [room, alice]);
  const open = (prompt, titleSource) => createRun({
    sessionId: room, startedBy: alice, agentId: "codex", baseSha: "0".repeat(40),
    title: draftRunTitle(prompt), titleSource,
  });

  await test("a draft keeps the ask and drops the politeness around it", () => {
    assert.equal(draftRunTitle("hey, can you please fix the login redirect loop?"), "Fix the login redirect loop");
    assert.equal(draftRunTitle("I need you to add rate limiting to the webhook route"), "Add rate limiting to the webhook route");
    assert.equal(draftRunTitle("let's migrate the sessions table to uuidv7"), "Migrate the sessions table to uuidv7");
  });

  await test("only the opening sentence names the chat", () => {
    assert.equal(
      draftRunTitle("Fix the flaky upload test. It fails on CI about one run in five, usually in teardown."),
      "Fix the flaky upload test",
    );
  });

  await test("identifiers, paths and casing survive; code fences and chat refs do not", () => {
    assert.equal(draftRunTitle("why does `parseHeadSha` return null in app/lib/git.ts?"), "Why does parseHeadSha return null in app/lib/git.ts");
    assert.equal(draftRunTitle("PostgreSQL deadlock on publish"), "PostgreSQL deadlock on publish");
    assert.equal(
      draftRunTitle("Compare with @design/3f6a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8 and explain the difference"),
      "Compare with and explain the difference",
    );
    assert.match(draftRunTitle("```js\nconst x = 1\n```\nExplain this snippet"), /^Explain this snippet$/);
  });

  await test("a draft is bounded, cut on a word, and never empty", () => {
    const long = draftRunTitle(`Rewrite ${"the authentication middleware ".repeat(20)}`);
    assert.ok(long.length <= MAX_TITLE && long.length <= 60, `unexpected length ${long.length}`);
    assert.ok(!long.endsWith(" ") && !/\s\S{1,2}$/.test(long), "cut mid-word");
    assert.equal(draftRunTitle("   "), "New chat");
    assert.equal(draftRunTitle("please"), "Please");
  });

  await test("drafting is pure, so concurrent tabs agree on the name", () => {
    const prompt = "Could you please add a health check to the worker?";
    assert.equal(draftRunTitle(prompt), draftRunTitle(prompt));
  });

  await test("refinement replaces a draft exactly once, and only while it is still a draft", async () => {
    const run = await open("Fix the login redirect loop", "auto");
    assert.equal(await autoRenameRun(run.id, "Login redirect loop"), "Login redirect loop");
    // A second pass with the same name is not a change and is not broadcast.
    assert.equal(await autoRenameRun(run.id, "Login redirect loop"), null);
    assert.equal((await getRun(run.id)).title, "Login redirect loop");
  });

  await test("a name its driver typed is never overwritten, including mid-flight", async () => {
    const run = await open("Fix the login redirect loop", "auto");
    await renameRun(run.id, "Auth bug — do not rename");
    // Stands in for a refinement that was already in flight when they renamed.
    assert.equal(await autoRenameRun(run.id, "Login redirect loop"), null);
    assert.equal((await getRun(run.id)).title, "Auth bug — do not rename");
  });

  await test("a title supplied with the request is a person's choice, not a draft", async () => {
    const run = await open("Fix the login redirect loop", "manual");
    assert.equal(await autoRenameRun(run.id, "Something else"), null);
  });

  await test("refinement is off without a configured gateway, and tolerates a bad one", async () => {
    delete process.env.MEMORY_EXTRACTION_URL;
    delete process.env.MEMORY_EXTRACTION_MODEL;
    assert.equal(await refineRunTitle("Fix the login redirect loop"), null);

    process.env.MEMORY_EXTRACTION_URL = "https://titles.test/v1/chat/completions";
    process.env.MEMORY_EXTRACTION_MODEL = "test";
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        // The prompt travels as data, never as an instruction to the model.
        assert.equal(JSON.parse(body.messages[1].content).request, "Fix the login redirect loop");
        return Response.json({ choices: [{ message: { content: '{"title":"Login redirect loop."}' } }] });
      };
      assert.equal(await refineRunTitle("Fix the login redirect loop"), "Login redirect loop");

      for (const content of ['{"title":""}', '{"title":42}', "not json", `{"title":"${"x".repeat(200)}"}`]) {
        globalThis.fetch = async () => Response.json({ choices: [{ message: { content } }] });
        assert.equal(await refineRunTitle("Fix the login redirect loop"), null, content.slice(0, 20));
      }
      globalThis.fetch = async () => { throw new Error("gateway down"); };
      assert.equal(await refineRunTitle("Fix the login redirect loop"), null);
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.MEMORY_EXTRACTION_URL;
      delete process.env.MEMORY_EXTRACTION_MODEL;
    }
  });

  console.log(`\n${passed} chat naming tests passed`);
} catch (cause) {
  console.error(cause);
  process.exitCode = 1;
} finally {
  await db.close();
}
