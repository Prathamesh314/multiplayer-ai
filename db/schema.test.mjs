/**
 * Proves the schema, not the application: every case here is something the
 * database itself must refuse. Run with `npm run db:test`.
 *
 * Uses PGlite — real Postgres compiled to wasm — so the assertions run against
 * the same engine production uses, with no server to install.
 */
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
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

const db = await PGlite.create({ extensions: { citext } });
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

// --- time-ordered keys ------------------------------------------------------

await test("primary keys are time-ordered (uuidv7 where available)", async () => {
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(await user(`seq${i}`));
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, "ids should already be in ascending order");
});

await db.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
