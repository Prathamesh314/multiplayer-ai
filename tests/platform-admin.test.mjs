// The admin console's own sign-in (migration 065): lockout, sessions, the
// forced first password change, and the platform statistics it shows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { hashPassword } from "../app/lib/auth/password.ts";
import { AdminAuthError, adminForToken, changePassword, signIn, signOut } from "../app/lib/admin/auth.ts";
import { loadDashboard } from "../app/lib/admin/dashboard.ts";
import { policyFor } from "../app/lib/http/api-limit.ts";

test("administrators sign in, are locked out after wrong passwords, and must replace a generated password", async () => {
  const f = await memoryFixture();
  try {
    const seeded = (await f.db.query(`SELECT must_change_password, password_hash FROM platform_admins WHERE email = 'admin@multicode.ai'`)).rows[0];
    assert.equal(seeded.must_change_password, true, "the first administrator must choose their own password");
    assert.match(seeded.password_hash, /^scrypt\$/, "only a hash is stored");

    await f.db.query(`INSERT INTO platform_admins (email, display_name, password_hash) VALUES ('ops@example.com', 'Ops', $1)`, [await hashPassword("generated-password-1")]);
    await assert.rejects(signIn("nobody@example.com", "generated-password-1"), AdminAuthError);
    await assert.rejects(signIn("ops@example.com", "wrong"), /don't match/);

    const session = await signIn("OPS@example.com ", "generated-password-1");
    assert.equal(session.mustChangePassword, true);
    const admin = await adminForToken(session.token);
    assert.equal(admin?.email, "ops@example.com");
    assert.equal(await adminForToken("not-a-token"), null);

    // A second browser, then a password change: this session survives, the other ends.
    const other = await signIn("ops@example.com", "generated-password-1");
    await assert.rejects(changePassword(admin, "wrong", "a-long-new-password"), /not correct/);
    await assert.rejects(changePassword(admin, "generated-password-1", "short"), /12 characters/);
    await changePassword(admin, "generated-password-1", "a-long-new-password");
    assert.equal((await adminForToken(session.token))?.mustChangePassword, false);
    assert.equal(await adminForToken(other.token), null, "other sessions end when the password changes");
    await assert.rejects(signIn("ops@example.com", "generated-password-1"), /don't match/);

    // Five wrong passwords lock the account, even against the right one.
    for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(signIn("ops@example.com", "guess"));
    await assert.rejects(signIn("ops@example.com", "a-long-new-password"), (error) => error.status === 429);
    await f.db.query(`UPDATE platform_admins SET locked_until = now() - interval '1 second' WHERE email = 'ops@example.com'`);
    const again = await signIn("ops@example.com", "a-long-new-password");

    // Expired and signed-out sessions stop working; disabled administrators too.
    await signOut(await adminForToken(again.token));
    assert.equal(await adminForToken(again.token), null);
    await f.db.query(`UPDATE platform_admin_sessions SET expires_at = now() - interval '1 second'`);
    assert.equal(await adminForToken(session.token), null);
    await f.db.query(`UPDATE platform_admins SET disabled_at = now() WHERE email = 'ops@example.com'`);
    await assert.rejects(signIn("ops@example.com", "a-long-new-password"));

    const actions = (await f.db.query(`SELECT action FROM platform_admin_events WHERE email = 'ops@example.com' ORDER BY id`)).rows.map((row) => row.action);
    for (const action of ["login", "login_failed", "password_changed", "locked", "logout"]) assert.ok(actions.includes(action), `records ${action}`);

    assert.equal(policyFor("/api/admin/login", "POST"), "auth", "sign-in attempts share the strict per-address limit");
    assert.equal(policyFor("/api/admin/password", "POST"), "auth");
  } finally {
    await f.close();
  }
});

test("the dashboard loads platform statistics without secrets", async () => {
  const f = await memoryFixture();
  try {
    const data = await loadDashboard();
    assert.ok(data.kpis.users.value >= 3, "counts the fixture's people");
    assert.equal(data.signups.length, 30);
    assert.equal(data.turns.length, 30);
    assert.ok(data.users.some((user) => user.email && user.state));
    assert.ok(Array.isArray(data.health.integrations));
    assert.doesNotMatch(JSON.stringify(data), /password_hash|token_hash|scrypt\$|credential/, "no secrets reach the page");
  } finally {
    await f.close();
  }
});
