// The dashboard's handoff inbox: offers waiting for a member across rooms,
// the ones they sent, and who hears when a handoff changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createRun } from "../app/lib/ai/runs.ts";
import { changeHandoff, handoffAudience, listMyHandoffs } from "../app/lib/ai/handoff.ts";

test("handoffs wait on the dashboard for the people they were offered to", async () => {
  const f = await memoryFixture();
  try {
    await f.db.query(`INSERT INTO session_repos(session_id,root_name,base_branch,base_sha_at_fork,session_branch,head_sha) VALUES($1,'repo','main',$2,'main',$2)`, [f.room, "a".repeat(40)]);
    await f.db.query(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'editor','owner')`, [f.room, f.bob]);
    await f.db.query(`UPDATE project_members SET role='editor' WHERE user_id=$1`, [f.bob]);
    const run = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: "claude", baseSha: "a".repeat(40), title: "Fix login" });
    await changeHandoff(run.id, f.room, f.alice, { action: "offer", toUserId: f.bob, note: "Tests pass, needs the docs", version: 0 });

    const bobs = await listMyHandoffs(f.bob);
    assert.equal(bobs.received.length, 1);
    assert.deepEqual([bobs.received[0].title, bobs.received[0].person, bobs.received[0].direct, bobs.received[0].note, bobs.received[0].version],
      ["Fix login", "Alice", true, "Tests pass, needs the docs", 0]);
    assert.deepEqual((await listMyHandoffs(f.alice)).sent.map((item) => [item.title, item.person]), [["Fix login", "Bob"]]);
    assert.deepEqual((await listMyHandoffs(f.alice)).received, [], "your own offer is not waiting for you");
    assert.deepEqual(await listMyHandoffs(f.outsider), { received: [], sent: [] }, "nothing for people outside the room");
    assert.deepEqual(new Set(await handoffAudience(run.id, f.room)), new Set([f.alice, f.bob]), "the sender and the recipient hear about it");

    // Accepted: it leaves both inboxes.
    await changeHandoff(run.id, f.room, f.bob, { action: "accept", handoffId: bobs.received[0].id, version: 0 });
    assert.deepEqual(await listMyHandoffs(f.bob), { received: [], sent: [] });
    assert.deepEqual((await listMyHandoffs(f.alice)).sent, []);

    // An open offer reaches every editor of the room; expired ones are gone.
    await changeHandoff(run.id, f.room, f.bob, { action: "offer", toUserId: null, note: "", version: 1 });
    const open = (await listMyHandoffs(f.alice)).received;
    assert.deepEqual([open.length, open[0].direct, open[0].person], [1, false, "Bob"]);
    assert.ok((await handoffAudience(run.id, f.room)).includes(f.alice), "open offers notify the room's editors");
    await f.db.query(`UPDATE run_handoffs SET expires_at = now() - interval '1 second', created_at = now() - interval '2 hours' WHERE status = 'pending'`);
    assert.deepEqual((await listMyHandoffs(f.alice)).received, [], "expired offers leave the inbox");
  } finally {
    await f.close();
  }
});
