/**
 * Proves the schema, not the application: every case here is something the
 * database itself must refuse. Run with `npm run db:test`.
 *
 * Uses PGlite — real Postgres compiled to wasm — so the assertions run against
 * the same engine production uses, with no server to install.
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { migrate } from "./migrate.mjs";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (cause) {
    console.log(`  FAIL ${name}\n       ${cause.message.split("\n")[0]}`);
    failed += 1;
  }
}

/** Asserts the statement is rejected, optionally by a specific constraint. */
async function rejects(db, sql, params, expected) {
  let error = null;
  try {
    await db.query(sql, params);
  } catch (cause) {
    error = cause;
  }
  assert.ok(error, "expected the database to reject this, but it was accepted");
  if (expected) {
    assert.match(error.message, expected, `rejected, but not for the expected reason: ${error.message}`);
  }
}

const db = await PGlite.create({ extensions: { citext, vector } });
await migrate(db);

console.log("\nschema constraints\n");

// --- fixtures ---------------------------------------------------------------

const user = async (handle) =>
  (
    await db.query(
      `INSERT INTO users (handle, email, display_name, connect_code)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [handle, `${handle}@example.com`, handle, connectCode()],
    )
  ).rows[0].id;

// The alphabet the connect_code CHECK allows: no I, O, 0 or 1.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
let codeSeed = 0;

function connectCode() {
  codeSeed += 1;
  let n = codeSeed;
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return `PK-${out.slice(0, 4)}-${out.slice(4)}`;
}

const org = async (slug, ownerId) => {
  const id = (
    await db.query(`INSERT INTO orgs (slug, name, created_by) VALUES ($1, $2, $3) RETURNING id`, [
      slug,
      slug,
      ownerId,
    ])
  ).rows[0].id;
  await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [
    id,
    ownerId,
  ]);
  return id;
};

const team = async (orgId, slug) =>
  (
    await db.query(`INSERT INTO teams (org_id, slug, name) VALUES ($1, $2, $3) RETURNING id`, [
      orgId,
      slug,
      slug,
    ])
  ).rows[0].id;

const alice = await user("alice");
const bob = await user("bob");
const mallory = await user("mallory");

const acme = await org("acme", alice);
const rival = await org("rival", mallory);
const acmeCore = await team(acme, "core");

// --- identity ---------------------------------------------------------------

await test("emails are case-insensitively unique", async () => {
  // The real citext case: emails have no lowercase constraint, so without it
  // Alice@Example.com and alice@example.com would be two accounts.
  await rejects(
    db,
    `INSERT INTO users (handle, email, display_name, connect_code) VALUES ($1,$2,$3,$4)`,
    ["alice2", "Alice@Example.com", "Alice Again", connectCode()],
    /duplicate key|unique/i,
  );
});

await test("a user is found regardless of the case queried", async () => {
  const { rows } = await db.query(`SELECT id FROM users WHERE email = $1`, ["ALICE@EXAMPLE.COM"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, alice);
});

await test("uppercase handles are rejected outright", async () => {
  await rejects(
    db,
    `INSERT INTO users (handle, email, display_name, connect_code) VALUES ($1,$2,$3,$4)`,
    ["NotLower", "nl@example.com", "NL", "PK-YYYY-YYYY"],
    /users_handle_format/,
  );
});

await test("a malformed connect code is rejected", async () => {
  await rejects(
    db,
    `INSERT INTO users (handle, email, display_name, connect_code) VALUES ($1,$2,$3,$4)`,
    ["carol", "carol@example.com", "Carol", "not-a-code"],
    /users_connect_code_format/,
  );
});

await test("an auth token cannot expire before it was issued", async () => {
  await rejects(
    db,
    `INSERT INTO auth_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() - interval '1 day')`,
    [alice, Buffer.from("x")],
    /auth_tokens_expiry_after_issue/,
  );
});

// --- the composite-FK tenant guard -----------------------------------------

await test("a non-member cannot be added to a team", async () => {
  await rejects(
    db,
    `INSERT INTO team_members (team_id, org_id, user_id) VALUES ($1, $2, $3)`,
    [acmeCore, acme, bob],
    /foreign key/i,
  );
});

await test("a member of another org cannot be smuggled in via org_id", async () => {
  await rejects(
    db,
    `INSERT INTO team_members (team_id, org_id, user_id) VALUES ($1, $2, $3)`,
    [acmeCore, rival, mallory],
    /foreign key/i,
  );
});

await test("an org member can be added to a team in that org", async () => {
  await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [
    acme,
    bob,
  ]);
  await db.query(`INSERT INTO team_members (team_id, org_id, user_id) VALUES ($1, $2, $3)`, [
    acmeCore,
    acme,
    bob,
  ]);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM team_members WHERE user_id = $1`, [
    bob,
  ]);
  assert.equal(rows[0].n, 1);
});

await test("removing an org member cascades every team membership", async () => {
  await db.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [acme, bob]);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM team_members WHERE user_id = $1`, [
    bob,
  ]);
  assert.equal(rows[0].n, 0, "team membership should have gone with the org membership");
});

// --- the deferred owner guard ----------------------------------------------

await test("the last owner cannot be demoted", async () => {
  await db.exec("BEGIN");
  await db.query(`UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [
    acme,
    alice,
  ]);
  let error = null;
  try {
    await db.exec("COMMIT");
  } catch (cause) {
    error = cause;
  }
  await db.exec("ROLLBACK").catch(() => {});
  assert.ok(error, "commit should have failed");
  assert.match(error.message, /without an active owner/);
});

await test("owners can be swapped inside one transaction", async () => {
  await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [
    acme,
    bob,
  ]);
  await db.exec("BEGIN");
  await db.query(`UPDATE org_members SET role = 'owner'  WHERE org_id = $1 AND user_id = $2`, [acme, bob]);
  await db.query(`UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [acme, alice]);
  await db.exec("COMMIT");

  const { rows } = await db.query(
    `SELECT user_id FROM org_members WHERE org_id = $1 AND role = 'owner'`,
    [acme],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, bob);

  // put it back for later tests
  await db.exec("BEGIN");
  await db.query(`UPDATE org_members SET role = 'owner'  WHERE org_id = $1 AND user_id = $2`, [acme, alice]);
  await db.query(`UPDATE org_members SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [acme, bob]);
  await db.exec("COMMIT");
});

// --- invitations ------------------------------------------------------------

const invite = (extra) =>
  db.query(
    `INSERT INTO org_invitations (org_id, via, email, invitee_user_id, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, 'member', $5, $6, now() + interval '7 days') RETURNING id`,
    [acme, extra.via, extra.email ?? null, extra.user ?? null, extra.token ?? null, alice],
  );

await test("an invitation cannot name both an email and a user", async () => {
  await rejects(
    db,
    `INSERT INTO org_invitations (org_id, via, email, invitee_user_id, role, token_hash, invited_by, expires_at)
     VALUES ($1, 'email', 'x@example.com', $2, 'member', $3, $4, now() + interval '1 day')`,
    [acme, mallory, Buffer.from("t"), alice],
    /one_identification/,
  );
});

await test("a connect-code invitation cannot name an email", async () => {
  await rejects(
    db,
    `INSERT INTO org_invitations (org_id, via, email, role, invited_by, expires_at)
     VALUES ($1, 'connect_code', 'x@example.com', 'member', $2, now() + interval '1 day')`,
    [acme, alice],
    /one_identification/,
  );
});

await test("an email invitation must carry a token", async () => {
  await rejects(
    db,
    `INSERT INTO org_invitations (org_id, via, email, role, invited_by, expires_at)
     VALUES ($1, 'email', 'x@example.com', 'member', $2, now() + interval '1 day')`,
    [acme, alice],
    /email_needs_token/,
  );
});

await test("only one live invitation per person per org", async () => {
  await invite({ via: "connect_code", user: mallory });
  await rejects(
    db,
    `INSERT INTO org_invitations (org_id, via, invitee_user_id, role, invited_by, expires_at)
     VALUES ($1, 'connect_code', $2, 'member', $3, now() + interval '1 day')`,
    [acme, mallory, alice],
    /duplicate key|unique/i,
  );
});

await test("revoking frees the slot for a fresh invitation", async () => {
  await db.query(
    `UPDATE org_invitations SET revoked_at = now()
      WHERE org_id = $1 AND invitee_user_id = $2 AND revoked_at IS NULL`,
    [acme, mallory],
  );
  const { rows } = await invite({ via: "connect_code", user: mallory });
  assert.ok(rows[0].id);
});

// --- projects and sessions --------------------------------------------------

const acmeProject = (
  await db.query(
    `INSERT INTO projects (org_id, slug, name, created_by) VALUES ($1,'web','Web',$2) RETURNING id`,
    [acme, alice],
  )
).rows[0].id;

await test("a session cannot point at a project in another org", async () => {
  await rejects(
    db,
    `INSERT INTO sessions (id, owner_id, org_id, project_id, name, join_code)
     VALUES ('aaaabbbbcccc', $1, $2, $3, 'Nope', 'AAAA-BBBB')`,
    [mallory, rival, acmeProject],
    /foreign key/i,
  );
});

await test("a personal session may have no org and no project", async () => {
  await db.query(
    `INSERT INTO sessions (id, owner_id, name, join_code)
     VALUES ('bbbbccccdddd', $1, 'Personal', 'CCCC-DDDD')`,
    [alice],
  );
  const { rows } = await db.query(`SELECT org_id, project_id FROM sessions WHERE id = $1`, [
    "bbbbccccdddd",
  ]);
  assert.equal(rows[0].org_id, null);
  assert.equal(rows[0].project_id, null);
});

await test("a session id must match the generated format", async () => {
  await rejects(
    db,
    `INSERT INTO sessions (id, owner_id, name, join_code) VALUES ('TOO-SHORT', $1, 'x', 'CCCC-DDDD')`,
    [alice],
    /sessions_id_format/,
  );
});

await test("a session cannot be owned by nobody", async () => {
  await rejects(
    db,
    `INSERT INTO sessions (id, name, join_code) VALUES ('ccccddddeeee', 'x', 'CCCC-DDDD')`,
    [],
    /owner_id/,
  );
});

await test("deleting a session takes its repo and roster with it", async () => {
  await db.query(
    `INSERT INTO session_repos (session_id, root_name, base_branch, base_sha_at_fork, session_branch, head_sha)
     VALUES ('bbbbccccdddd', 'demo', 'main', 'abc', 'session/bbbbccccdddd', 'abc')`,
  );
  await db.query(
    `INSERT INTO session_members (session_id, user_id, role, added_via)
     VALUES ('bbbbccccdddd', $1, 'owner', 'owner')`,
    [alice],
  );
  await db.query(`DELETE FROM sessions WHERE id = 'bbbbccccdddd'`);

  const repos = await db.query(`SELECT count(*)::int AS n FROM session_repos`);
  const members = await db.query(`SELECT count(*)::int AS n FROM session_members`);
  assert.equal(repos.rows[0].n, 0);
  assert.equal(members.rows[0].n, 0);
});

// --- one room per member per project ----------------------------------------

await test("a member cannot hold two rooms in the same project", async () => {
  await db.query(
    `INSERT INTO sessions (id, owner_id, org_id, project_id, name, join_code)
     VALUES ('roomaliceweb', $1, $2, $3, 'alice', 'EEEE-FFFF')`,
    [alice, acme, acmeProject],
  );
  await rejects(
    db,
    `INSERT INTO sessions (id, owner_id, org_id, project_id, name, join_code)
     VALUES ('roomalicetwo', $1, $2, $3, 'alice again', 'FFFF-GGGG')`,
    [alice, acme, acmeProject],
    /sessions_member_room_key/,
  );
});

await test("another member gets a room of their own in the same project", async () => {
  await db.query(
    `INSERT INTO sessions (id, owner_id, org_id, project_id, name, join_code)
     VALUES ('roombobwebbb', $1, $2, $3, 'bob', 'GGGG-HHHH')`,
    [bob, acme, acmeProject],
  );
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM sessions WHERE project_id = $1`,
    [acmeProject],
  );
  assert.equal(rows[0].n, 2);
});

await test("personal rooms are not limited to one per owner", async () => {
  await db.query(
    `INSERT INTO sessions (id, owner_id, name, join_code)
     VALUES ('persaliceaaa', $1, 'Personal A', 'HHHH-JJJJ'),
            ('persalicebbb', $1, 'Personal B', 'JJJJ-KKKK')`,
    [alice],
  );
});

// --- project members: the access gate --------------------------------------

await test("a github project must name a repo", async () => {
  await rejects(
    db,
    `INSERT INTO projects (org_id, slug, name, created_by, source)
     VALUES ($1, 'gh1', 'GH', $2, 'github')`,
    [acme, alice],
    /projects_github_needs_repo/,
  );
});

await test("a non-org-member cannot be added to a project", async () => {
  // carol exists as a user but is in no org.
  const carol = await user("carolpm");
  await rejects(
    db,
    `INSERT INTO project_members (project_id, org_id, user_id, role)
     VALUES ($1, $2, $3, 'editor')`,
    [acmeProject, acme, carol],
    /foreign key/i,
  );
});

await test("a member of another org cannot be smuggled into a project via org_id", async () => {
  await rejects(
    db,
    `INSERT INTO project_members (project_id, org_id, user_id, role)
     VALUES ($1, $2, $3, 'editor')`,
    [acmeProject, rival, mallory],
    /foreign key/i,
  );
});

await test("an org member can be added to a project in that org", async () => {
  await db.query(
    `INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')
     ON CONFLICT (org_id, user_id) DO NOTHING`,
    [acme, bob],
  );
  await db.query(
    `INSERT INTO project_members (project_id, org_id, user_id, role)
     VALUES ($1, $2, $3, 'editor')`,
    [acmeProject, acme, bob],
  );
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM project_members WHERE user_id = $1`,
    [bob],
  );
  assert.equal(rows[0].n, 1);
});

await test("removing an org member cascades project membership", async () => {
  await db.query(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [acme, bob]);
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM project_members WHERE user_id = $1`,
    [bob],
  );
  assert.equal(rows[0].n, 0, "project membership should have gone with the org membership");
});

// --- agent runs -------------------------------------------------------------

const runSession = "runrunrunrun";
await db.query(
  `INSERT INTO sessions (id, owner_id, name, join_code)
   VALUES ($1, $2, 'Run room', 'RUNR-2345')`,
  [runSession, alice],
);
const aRun = (
  await db.query(
    `INSERT INTO agent_runs (session_id, started_by, agent_id, base_sha)
     VALUES ($1, $2, 'claude', 'abc123') RETURNING id`,
    [runSession, alice],
  )
).rows[0].id;

await test("a run status is constrained to the known set", async () => {
  await rejects(
    db,
    `INSERT INTO agent_runs (session_id, started_by, agent_id, base_sha, status)
     VALUES ($1, $2, 'claude', 'abc', 'exploded')`,
    [runSession, alice],
    /agent_runs_status_check|check/i,
  );
});

await test("a run starts unarchived", async () => {
  const { rows } = await db.query(`SELECT archived_at FROM agent_runs WHERE id = $1`, [aRun]);
  assert.equal(rows[0].archived_at, null, "a fresh run should not be archived");
});

await test("a user turn must carry an author", async () => {
  await rejects(
    db,
    `INSERT INTO agent_run_messages (run_id, seq, role, body)
     VALUES ($1, 1, 'user', 'hi')`,
    [aRun],
    /agent_run_messages_user_has_author/,
  );
});

await test("an agent turn must not carry an author", async () => {
  await rejects(
    db,
    `INSERT INTO agent_run_messages (run_id, seq, role, author_user_id, body)
     VALUES ($1, 2, 'agent', $2, 'output')`,
    [aRun, alice],
    /agent_run_messages_user_has_author/,
  );
});

await test("seq is unique within a run", async () => {
  await db.query(
    `INSERT INTO agent_run_messages (run_id, seq, role, author_user_id, body)
     VALUES ($1, 1, 'user', $2, 'first prompt')`,
    [aRun, alice],
  );
  await rejects(
    db,
    `INSERT INTO agent_run_messages (run_id, seq, role, body)
     VALUES ($1, 1, 'agent', 'dup seq')`,
    [aRun],
    /duplicate key|unique/i,
  );
});

// --- ai memories -------------------------------------------------------------

const memSourceRun = (
  await db.query(
    `INSERT INTO agent_runs (session_id, started_by, agent_id, base_sha)
     VALUES ($1, $2, 'claude', 'abc123') RETURNING id`,
    [runSession, alice],
  )
).rows[0].id;

const memDestRun = (
  await db.query(
    `INSERT INTO agent_runs (session_id, started_by, agent_id, base_sha)
     VALUES ($1, $2, 'claude', 'abc123') RETURNING id`,
    [runSession, alice],
  )
).rows[0].id;

await test("a memory's content cannot be blank", async () => {
  await rejects(
    db,
    `INSERT INTO ai_memories (run_id, forked_from_run_id, content, created_by)
     VALUES ($1, $2, '   ', $3)`,
    [memDestRun, memSourceRun, alice],
    /ai_memories_content_present/,
  );
});

await test("deleting the destination run takes its imported memory with it", async () => {
  const memId = (
    await db.query(
      `INSERT INTO ai_memories (run_id, forked_from_run_id, content, created_by)
       VALUES ($1, $2, 'hello from the source chat', $3) RETURNING id`,
      [memDestRun, memSourceRun, alice],
    )
  ).rows[0].id;
  await db.query(`DELETE FROM agent_runs WHERE id = $1`, [memDestRun]);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ai_memories WHERE id = $1`, [memId]);
  assert.equal(rows[0].n, 0);
});

await test("deleting the source run cascades to memories forked from it", async () => {
  const freshDest = (
    await db.query(
      `INSERT INTO agent_runs (session_id, started_by, agent_id, base_sha)
       VALUES ($1, $2, 'claude', 'abc123') RETURNING id`,
      [runSession, alice],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO ai_memories (run_id, forked_from_run_id, content, created_by)
     VALUES ($1, $2, 'hello again', $3)`,
    [freshDest, memSourceRun, alice],
  );
  await db.query(`DELETE FROM agent_runs WHERE id = $1`, [memSourceRun]);
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM ai_memories WHERE forked_from_run_id = $1`,
    [memSourceRun],
  );
  assert.equal(rows[0].n, 0);
});

await test("deleting a run takes its messages and participants with it", async () => {
  await db.query(
    `INSERT INTO agent_run_participants (run_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [aRun, alice],
  );
  await db.query(`DELETE FROM agent_runs WHERE id = $1`, [aRun]);
  const msgs = await db.query(`SELECT count(*)::int AS n FROM agent_run_messages`);
  const parts = await db.query(`SELECT count(*)::int AS n FROM agent_run_participants`);
  assert.equal(msgs.rows[0].n, 0);
  assert.equal(parts.rows[0].n, 0);
});

// --- approval-gated memory staging ------------------------------------------

const stagedRun = (
  await db.query(
    `INSERT INTO agent_runs (session_id, started_by, agent_id, base_sha)
     VALUES ($1, $2, 'claude', 'abc123') RETURNING id`,
    [runSession, alice],
  )
).rows[0].id;

/** The drain used by ingestApprovedExchanges (app/lib/ai/shared-memory.ts). */
const drainSql = `
  WITH drained AS (
    DELETE FROM staged_memory_exchanges
     WHERE session_id = $1
     RETURNING prompt, reply, created_at
  )
  SELECT prompt, reply FROM drained ORDER BY created_at`;

await test("publishing drains staged exchanges exactly once, oldest first", async () => {
  await db.query(
    `INSERT INTO staged_memory_exchanges (session_id, run_id, prompt, reply)
     VALUES ($1, $2, 'first prompt', 'first reply'), ($1, $2, 'second prompt', 'second reply')`,
    [runSession, stagedRun],
  );
  const first = await db.query(drainSql, [runSession]);
  assert.deepEqual(
    first.rows.map((r) => r.prompt),
    ["first prompt", "second prompt"],
    "drained in ingestion order",
  );
  const second = await db.query(drainSql, [runSession]);
  assert.equal(second.rows.length, 0, "a second publish claims nothing — no double ingest");
});

await test("deleting a run discards its never-approved staged exchanges", async () => {
  await db.query(
    `INSERT INTO staged_memory_exchanges (session_id, run_id, prompt, reply)
     VALUES ($1, $2, 'orphan', 'orphan')`,
    [runSession, stagedRun],
  );
  await db.query(`DELETE FROM agent_runs WHERE id = $1`, [stagedRun]);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM staged_memory_exchanges`);
  assert.equal(rows[0].n, 0, "cascade cleared the backlog");
});

// --- room repos ---------------------------------------------------------------

await test("a room repo takes only session-alphabet ids", async () => {
  await rejects(
    db,
    `INSERT INTO room_repos (id, session_id, root_name, created_by) VALUES ('BAD-ID!!', $1, 'x', $2)`,
    [runSession, alice],
    /check/i,
  );
});

await test("a room holds several repos, but names stay unique within it", async () => {
  await db.query(
    `INSERT INTO room_repos (id, session_id, root_name, created_by)
     VALUES ('zzzzyyyyxxxx', $1, 'side-project', $2), ('aaaabbbbccc2', $1, 'other-app', $2)`,
    [runSession, alice],
  );
  await rejects(
    db,
    `INSERT INTO room_repos (id, session_id, root_name, created_by)
     VALUES ('ccccddddeee2', $1, 'side-project', $2)`,
    [runSession, alice],
    /unique|duplicate/i,
  );
});

await test("a chat binds to a room repo; removing the repo keeps the chat", async () => {
  const bound = (
    await db.query(
      `INSERT INTO agent_runs (session_id, repo_id, started_by, agent_id, base_sha)
       VALUES ($1, 'zzzzyyyyxxxx', $2, 'claude', 'abc123') RETURNING id`,
      [runSession, alice],
    )
  ).rows[0].id;
  await db.query(`DELETE FROM room_repos WHERE id = 'zzzzyyyyxxxx'`);
  const { rows } = await db.query(`SELECT repo_id FROM agent_runs WHERE id = $1`, [bound]);
  assert.equal(rows[0].repo_id, null, "the conversation survives, unbound");
});

await test("deleting a room takes its imported repos with it", async () => {
  await db.query(
    `INSERT INTO sessions (id, owner_id, name, join_code)
     VALUES ('reporoomabcd', $1, 'Repo room', 'RRRR-2345')`,
    [alice],
  );
  await db.query(
    `INSERT INTO room_repos (id, session_id, root_name, created_by)
     VALUES ('ddddeeeeffff', 'reporoomabcd', 'doomed', $1)`,
    [alice],
  );
  await db.query(`DELETE FROM sessions WHERE id = 'reporoomabcd'`);
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM room_repos WHERE session_id = 'reporoomabcd'`,
  );
  assert.equal(rows[0].n, 0, "cascade removed the imports");
});

// --- runner devices ----------------------------------------------------------

const aliceDevice = (
  await db.query(
    `INSERT INTO runner_devices (user_id, name, token_hash) VALUES ($1, 'MacBook', $2) RETURNING id`,
    [alice, Buffer.from("device-token-hash-1")],
  )
).rows[0].id;

await test("two devices cannot share a token hash", async () => {
  await rejects(
    db,
    `INSERT INTO runner_devices (user_id, name, token_hash) VALUES ($1, 'Clone', $2)`,
    [alice, Buffer.from("device-token-hash-1")],
    /duplicate key|unique/i,
  );
});

await test("a pairing code cannot expire before it was minted", async () => {
  await rejects(
    db,
    `INSERT INTO runner_pairing_codes (code_hash, user_id, expires_at)
     VALUES ($1, $2, now() - interval '1 minute')`,
    [Buffer.from("code-hash-1"), alice],
    /runner_pairing_codes_expiry/,
  );
});

await test("a run's execution mode is constrained to server or local", async () => {
  await rejects(
    db,
    `INSERT INTO agent_runs (session_id, started_by, agent_id, base_sha, execution)
     VALUES ($1, $2, 'claude', 'abc123', 'cloud9')`,
    [runSession, alice],
    /check/i,
  );
});

await test("revoking a device row leaves its past runs readable", async () => {
  const localRun = (
    await db.query(
      `INSERT INTO agent_runs (session_id, started_by, agent_id, base_sha, execution, assigned_device_id)
       VALUES ($1, $2, 'claude', 'abc123', 'local', $3) RETURNING id`,
      [runSession, alice, aliceDevice],
    )
  ).rows[0].id;
  await db.query(`DELETE FROM runner_devices WHERE id = $1`, [aliceDevice]);
  const { rows } = await db.query(`SELECT assigned_device_id, execution FROM agent_runs WHERE id = $1`, [
    localRun,
  ]);
  assert.equal(rows[0].assigned_device_id, null, "device link nulled, not cascaded");
  assert.equal(rows[0].execution, "local", "the run's history is intact");
});

// --- runner jobs --------------------------------------------------------------

const jobRun = (
  await db.query(
    `INSERT INTO agent_runs (session_id, started_by, agent_id, base_sha)
     VALUES ($1, $2, 'claude', 'abc123') RETURNING id`,
    [runSession, alice],
  )
).rows[0].id;

/** The claim shape used by claimNextJob (app/lib/runner/jobs.ts). */
const claimJobSql = `
  UPDATE runner_jobs SET status = 'claimed', claimed_at = now()
   WHERE run_id = (
     SELECT run_id FROM runner_jobs
      WHERE user_id = $1 AND status = 'queued'
      ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
   )
   RETURNING run_id`;

await test("a queued job is claimed exactly once", async () => {
  await db.query(
    `INSERT INTO runner_jobs (run_id, user_id, payload) VALUES ($1, $2, '{"runId":"x"}')`,
    [jobRun, alice],
  );
  const first = await db.query(claimJobSql, [alice]);
  assert.equal(first.rows.length, 1, "first claim wins");
  const second = await db.query(claimJobSql, [alice]);
  assert.equal(second.rows.length, 0, "second claim finds nothing");
});

await test("the cloud fallback cannot reclaim a job a runner already has", async () => {
  const reclaimed = await db.query(
    `UPDATE runner_jobs SET status = 'reclaimed'
      WHERE run_id = $1 AND status = 'queued' RETURNING run_id`,
    [jobRun],
  );
  assert.equal(reclaimed.rows.length, 0, "claimed job stays with its runner");
});

await test("a job status outside the lifecycle is rejected", async () => {
  await rejects(
    db,
    `UPDATE runner_jobs SET status = 'paused' WHERE run_id = $1`,
    [jobRun],
    /check/i,
  );
});

await test("deleting the run takes its queue entry with it", async () => {
  await db.query(`DELETE FROM agent_runs WHERE id = $1`, [jobRun]);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM runner_jobs`);
  assert.equal(rows[0].n, 0);
});

// --- repo-context index -----------------------------------------------------

/**
 * Legacy pointer compatibility after migration 029. These checks preserve
 * the heterogeneous key behavior; tests/repo-context.test.mjs exercises the
 * new durable jobs, atomic source publication, and pgvector retrieval.
 */
const claimSql = `
  INSERT INTO repo_context_index (repo_ref, head_sha)
  VALUES ($1, $2)
  ON CONFLICT (repo_ref) DO UPDATE
     SET head_sha = EXCLUDED.head_sha, indexed_at = now()
   WHERE repo_context_index.head_sha IS DISTINCT FROM EXCLUDED.head_sha
  RETURNING head_sha`;

await test("the repo-context claim wins on first insert and on a new head", async () => {
  const first = await db.query(claimSql, [acmeProject, "sha-one"]);
  assert.equal(first.rows.length, 1, "first index claims");
  const advanced = await db.query(claimSql, [acmeProject, "sha-two"]);
  assert.equal(advanced.rows.length, 1, "a new head claims again");
});

await test("the repo-context claim is a no-op when the head is unchanged", async () => {
  const repeat = await db.query(claimSql, [acmeProject, "sha-two"]);
  assert.equal(repeat.rows.length, 0, "same head → no claim, no re-index");
});

await test("heterogeneous refs coexist and outlive their repos", async () => {
  // A room-fork ref alongside the project ref: both are just pointers.
  await db.query(claimSql, [runSession, "sha-fork"]);
  const both = await db.query(`SELECT count(*)::int AS n FROM repo_context_index`);
  assert.equal(both.rows[0].n, 2);
  // No FK on purpose: deleting the project leaves an inert pointer at a bank
  // nothing will query, exactly like a superseded per-SHA bank.
  await db.query(`DELETE FROM projects WHERE id = $1`, [acmeProject]);
  const after = await db.query(`SELECT count(*)::int AS n FROM repo_context_index`);
  assert.equal(after.rows[0].n, 2, "pointers survive their ref's deletion");
});

// --- time-ordered keys ------------------------------------------------------

await test("primary keys are time-ordered (uuidv7 where available)", async () => {
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(await user(`seq${i}`));
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, "ids should already be in ascending order");
});

// --- team chat (channels + DMs) --------------------------------------------

await test("a channel must carry a name", async () => {
  await rejects(
    db,
    `INSERT INTO conversations (org_id, kind) VALUES ($1, 'channel')`,
    [acme],
    /conversations_channel_named/,
  );
});

await test("a DM must be private and carry a dm_key", async () => {
  await rejects(
    db,
    `INSERT INTO conversations (org_id, kind, visibility) VALUES ($1, 'dm', 'public')`,
    [acme],
    /conversations_dm_shape/,
  );
});

await test("the same pair cannot open two DMs in one org", async () => {
  // bob joins acme so he can share a conversation there.
  await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [
    acme,
    bob,
  ]);
  const key = [alice, bob].sort().join(":");
  await db.query(
    `INSERT INTO conversations (org_id, kind, visibility, dm_key) VALUES ($1, 'dm', 'private', $2)`,
    [acme, key],
  );
  await rejects(
    db,
    `INSERT INTO conversations (org_id, kind, visibility, dm_key) VALUES ($1, 'dm', 'private', $2)`,
    [acme, key],
    /conversations_dm_key_idx|duplicate key/,
  );
});

await test("a member of another org cannot be smuggled into a conversation", async () => {
  const channel = (
    await db.query(
      `INSERT INTO conversations (org_id, kind, name) VALUES ($1, 'channel', 'general') RETURNING id`,
      [acme],
    )
  ).rows[0].id;
  // mallory is in rival, not acme — the composite FK to org_members must reject.
  await rejects(
    db,
    `INSERT INTO conversation_members (conversation_id, org_id, user_id) VALUES ($1, $2, $3)`,
    [channel, acme, mallory],
    /foreign key/,
  );
});

await test("a blank chat message is rejected", async () => {
  const channel = (
    await db.query(
      `INSERT INTO conversations (org_id, kind, name) VALUES ($1, 'channel', 'blanktest') RETURNING id`,
      [acme],
    )
  ).rows[0].id;
  await rejects(
    db,
    `INSERT INTO chat_messages (conversation_id, user_id, body) VALUES ($1, $2, '   ')`,
    [channel, alice],
    /chat_messages_body_present/,
  );
});

await test("deleting an org takes its conversations and messages with it", async () => {
  const owner = await user("chatowner");
  const o = await org("chatco", owner);
  const channel = (
    await db.query(
      `INSERT INTO conversations (org_id, kind, name) VALUES ($1, 'channel', 'general') RETURNING id`,
      [o],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO conversation_members (conversation_id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
    [channel, o, owner],
  );
  await db.query(`INSERT INTO chat_messages (conversation_id, user_id, body) VALUES ($1, $2, 'hi')`, [
    channel,
    owner,
  ]);
  await db.query(`DELETE FROM orgs WHERE id = $1`, [o]);
  const convs = await db.query(`SELECT count(*)::int AS n FROM conversations WHERE org_id = $1`, [o]);
  const msgs = await db.query(`SELECT count(*)::int AS n FROM chat_messages WHERE conversation_id = $1`, [
    channel,
  ]);
  assert.equal(convs.rows[0].n, 0);
  assert.equal(msgs.rows[0].n, 0, "messages should cascade with their conversation");
});

await db.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
