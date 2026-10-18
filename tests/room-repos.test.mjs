// Repositories in a room: private to the member who added it (files, chats and
// their live output hidden from everyone else, the room owner included), and
// deleted with their chats.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createRoomRepo, deleteRoomRepo, finishRoomRepoSeed, listRoomRepos, setRoomRepoVisibility } from "../app/lib/session/roomRepos.ts";
import { createRun, listRuns, listRunsForRooms, runHiddenFrom } from "../app/lib/ai/runs.ts";
import { resolveReferences } from "../app/lib/ai/context.ts";
import { resolveGitAccess } from "../app/lib/runner/git-access.ts";
import { roomEventVisibility } from "../app/lib/session/repo-visibility.ts";
import { resolveRepository } from "../app/lib/session/repository-context.ts";
import { getSession } from "../app/lib/session/store.ts";

test("a private repository and its chats are seen only by the member who added it", async () => {
  const f = await memoryFixture();
  try {
    await f.db.query(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'editor','owner')`, [f.room, f.bob]);
    await f.db.query(`UPDATE project_members SET role='editor' WHERE user_id=$1`, [f.bob]);
    const repo = await createRoomRepo({ sessionId: f.room, rootName: "bob-notes", createdBy: f.bob });
    await finishRoomRepoSeed(repo.id, { headSha: "b".repeat(40), upstreamUrl: null });
    const chat = await createRun({ sessionId: f.room, startedBy: f.bob, agentId: "claude", baseSha: "b".repeat(40), repoId: repo.id, title: "Draft" });

    await assert.rejects(setRoomRepoVisibility(f.room, repo.id, f.alice, "private"), (e) => e.status === 403, "only its creator decides");
    await assert.rejects(setRoomRepoVisibility(f.room, repo.id, f.bob, "secret"), (e) => e.status === 400);
    assert.equal((await setRoomRepoVisibility(f.room, repo.id, f.bob, "private")).visibility, "private");

    // Alice owns the room, yet sees nothing of it.
    assert.deepEqual((await listRoomRepos(f.room, f.alice)).map((item) => item.id), []);
    assert.deepEqual((await listRoomRepos(f.room, f.bob)).map((item) => item.id), [repo.id]);
    assert.deepEqual((await listRuns(f.room, f.alice)).map((run) => run.id), []);
    assert.deepEqual((await listRuns(f.room, f.bob)).map((run) => run.id), [chat.id]);
    assert.equal(await runHiddenFrom(chat.id, f.alice), true);
    assert.equal(await runHiddenFrom(chat.id, f.bob), false);
    assert.deepEqual(await listRunsForRooms([f.room], 50, f.alice), []);
    assert.deepEqual(await resolveReferences(f.project, f.alice, [chat.id]), [], "cannot be referenced with @");
    const session = await getSession(f.room, f.alice);
    assert.equal((await resolveRepository(session, repo.id, f.alice)).status, 404, "its files are not found");
    assert.equal(await resolveGitAccess(repo.id, f.alice, false), null, "a teammate's computer cannot fetch it");
    assert.ok(await resolveGitAccess(repo.id, f.bob, false));
    const forAlice = roomEventVisibility(f.alice), forBob = roomEventVisibility(f.bob);
    assert.equal(await forAlice.hidden({ type: "run.output", runId: chat.id, chunk: "secret", at: 0 }), true, "live output is filtered");
    assert.equal(await forAlice.hidden({ type: "file.saved", repoId: repo.id, path: "a", at: 0 }), true);
    assert.equal(await forAlice.hidden({ type: "repos.changed", repoId: repo.id, at: 0 }), false, "everyone hears to reload");
    assert.equal(await forBob.hidden({ type: "run.output", runId: chat.id, chunk: "mine", at: 0 }), false);
    assert.equal((await f.first("SELECT chat_share_manager($1,$2) AS ok", [chat.id, f.alice])).ok, false, "the room owner cannot share it either");
    await assert.rejects(deleteRoomRepo({ sessionId: f.room, repoId: repo.id, userId: f.alice, roomOwner: true }), (e) => e.status === 404);

    // Visible again; then it cannot go private while someone else has a chat in it.
    await setRoomRepoVisibility(f.room, repo.id, f.bob, "room");
    assert.equal(forAlice.reset(), undefined);
    assert.equal(await forAlice.hidden({ type: "run.output", runId: chat.id, chunk: "now visible", at: 0 }), false);
    await createRun({ sessionId: f.room, startedBy: f.alice, agentId: "codex", baseSha: "b".repeat(40), repoId: repo.id });
    await assert.rejects(setRoomRepoVisibility(f.room, repo.id, f.bob, "private"), (e) => e.status === 409 && /Alice/.test(e.message));
  } finally {
    await f.close();
  }
});

test("deleting a repository removes its chats; a working chat waits", async () => {
  const f = await memoryFixture();
  try {
    await f.db.query(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'editor','owner')`, [f.room, f.bob]);
    const repo = await createRoomRepo({ sessionId: f.room, rootName: "mistake", createdBy: f.alice });
    await finishRoomRepoSeed(repo.id, { headSha: "c".repeat(40), upstreamUrl: null });
    const chat = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: "claude", baseSha: "c".repeat(40), repoId: repo.id });
    const turn = randomUUID();
    await f.db.query(`INSERT INTO agent_turns(id,run_id,driver_user_id,control_version,status) VALUES ($1,$2,$3,0,'running')`, [turn, chat.id, f.alice]);
    await assert.rejects(deleteRoomRepo({ sessionId: f.room, repoId: repo.id, userId: f.bob, roomOwner: false }), (e) => e.status === 403, "not theirs");
    await assert.rejects(deleteRoomRepo({ sessionId: f.room, repoId: repo.id, userId: f.alice, roomOwner: true }), (e) => e.status === 409, "a working chat blocks it");
    await f.db.query(`UPDATE agent_turns SET status='completed', ended_at=now() WHERE id=$1`, [turn]);
    assert.deepEqual((await deleteRoomRepo({ sessionId: f.room, repoId: repo.id, userId: f.alice, roomOwner: true })).chats, 1);
    assert.deepEqual(await listRoomRepos(f.room, f.alice), []);
    assert.equal((await f.first("SELECT count(*)::int AS n FROM agent_runs WHERE id=$1", [chat.id])).n, 0, "its chats go with it, never onto the room's own files");
    await assert.rejects(deleteRoomRepo({ sessionId: f.room, repoId: repo.id, userId: f.alice, roomOwner: true }), (e) => e.status === 404);
  } finally {
    await f.close();
  }
});
