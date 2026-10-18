// Project rooms belong to added members: organisation admins looking at a
// project get none, stray empty ones are hidden, and a fork starts in the
// forker's own room.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createProject, memberRoleOf } from "../app/lib/project/store.ts";
import { createSession, getSession } from "../app/lib/session/store.ts";
import { createRun } from "../app/lib/ai/runs.ts";
import { forkTargetFor } from "../app/lib/ai/fork-target.ts";

test("only added members have a room; stray empty rooms of non-members are hidden", async () => {
  const f = await memoryFixture();
  try {
    const { project } = await createProject({ orgId: f.org, name: "Bob's project", createdBy: f.bob });
    assert.equal(await memberRoleOf(project.id, f.bob), "manager");
    assert.equal(await memberRoleOf(project.id, f.alice), null, "the org owner sees it but was never added");
    // What looking used to leave behind, next to rooms with work in them.
    const stray = await createSession(f.alice, "alice", { orgId: f.org, projectId: project.id, pinned: true });
    const bobs = await createSession(f.bob, "bob", { orgId: f.org, projectId: project.id, pinned: true });
    // The outsider's room in the first project is not theirs by membership either, but it holds a chat.
    const used = { id: f.secret };
    await createRun({ sessionId: f.secret, startedBy: f.outsider, agentId: "codex", baseSha: "a".repeat(40) });
    await f.db.exec(await readFile(new URL("../db/migrations/064_hide_unearned_member_rooms.sql", import.meta.url), "utf8"));
    const deleted = async (id) => (await f.first("SELECT deleted_at FROM sessions WHERE id=$1", [id])).deleted_at !== null;
    assert.equal(await deleted(stray.id), true, "an empty room of someone never added is hidden");
    assert.equal(await deleted(bobs.id), false, "a member's own room stays");
    assert.equal(await deleted(used.id), false, "a room with work in it stays");
  } finally {
    await f.close();
  }
});

test("forking a chat in someone else's room starts it in your own room of the project", async () => {
  const f = await memoryFixture();
  try {
    // Alice is an editor of the project with her room; Bob's room holds the chat.
    const room = await getSession(f.other, f.bob);
    const run = await createRun({ sessionId: f.other, startedBy: f.bob, agentId: "codex", baseSha: "a".repeat(40) });
    const forAlice = await forkTargetFor(room, run, { id: f.alice, handle: "alice" });
    assert.deepEqual(forAlice, { sessionId: f.room, repoId: null });
    assert.deepEqual(await forkTargetFor(room, run, { id: f.outsider, handle: "outsider" }), { sessionId: f.other, repoId: null }, "not on the project: stays");
    const own = await getSession(f.room, f.alice);
    const mine = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: "codex", baseSha: "a".repeat(40) });
    assert.deepEqual(await forkTargetFor(own, mine, { id: f.alice, handle: "alice" }), { sessionId: f.room, repoId: null }, "already your room");
    assert.deepEqual(await forkTargetFor({ id: "personalroom", projectId: null, orgId: null }, { sessionId: "personalroom", repoId: null }, { id: f.alice, handle: "alice" }),
      { sessionId: "personalroom", repoId: null }, "outside a project: stays");
  } finally {
    await f.close();
  }
});
