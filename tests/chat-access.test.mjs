import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryFixture } from './helpers/memory-fixture.mjs';
import { createChannel, getOrCreateDm, loadConversation, listConversations, listMessages, createMessage, ensureMember } from '../app/lib/chat/store.ts';

const f = await memoryFixture();
try {
  const publicId = await createChannel(f.org, f.alice, 'general', 'public');
  const privateId = await createChannel(f.org, f.alice, 'private', 'private', [f.bob]);
  const dmId = await getOrCreateDm(f.org, f.alice, f.bob);
  await ensureMember(publicId, f.org, f.bob);
  for (const id of [publicId, privateId, dmId]) {
    assert.ok(await loadConversation(id, f.bob));
    await createMessage(id, f.bob, 'Before suspension');
  }
  assert.equal(await loadConversation(privateId, f.outsider), null, 'private channels require explicit membership');
  assert.equal(await loadConversation(dmId, f.outsider), null, 'DMs stay private');
  assert.equal(await loadConversation(publicId, randomUUID()), null, 'public means active org members, not the internet');
  await f.db.query("UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2", [f.org, f.bob]);
  for (const id of [publicId, privateId, dmId]) {
    assert.equal(await loadConversation(id, f.bob), null, 'suspension overrides explicit conversation membership');
    await assert.rejects(createMessage(id, f.bob, 'Must not be stored'), /access/i);
    assert.equal(await ensureMember(id, f.org, f.bob), false);
  }
  assert.deepEqual(await listConversations(f.org, f.bob), []);
  await assert.rejects(createChannel(f.org, f.bob, 'forbidden', 'public'), /access/i);
  await assert.rejects(getOrCreateDm(f.org, f.alice, f.bob), /access/i);
  assert.equal((await f.first("SELECT count(*)::int AS n FROM chat_messages WHERE body='Must not be stored'")).n, 0);
  await f.db.query("UPDATE org_members SET status='active' WHERE org_id=$1 AND user_id=$2", [f.org, f.bob]);
  assert.ok(await loadConversation(privateId, f.bob));
  await f.db.query('UPDATE conversation_members SET removed_at=now() WHERE conversation_id=$1 AND user_id=$2', [privateId, f.bob]);
  assert.equal(await ensureMember(privateId, f.org, f.bob), false, 'opening cannot revive revoked private access');
  assert.equal(await loadConversation(privateId, f.bob), null);
  // UUIDv4 IDs deliberately sort differently from creation time. Paging must
  // use the index's full ordering, not assume that every UUID is chronological.
  const history = await createChannel(f.org, f.alice, 'history', 'public');
  const ids = Array.from({length:55},()=>randomUUID()).sort().reverse();
  for (const [index, id] of ids.entries()) await f.db.query(`INSERT INTO chat_messages(id,conversation_id,user_id,body,created_at)
    VALUES ($1,$2,$3,$4,'2026-01-01'::timestamptz + make_interval(secs => $5))`, [id,history,f.alice,`Message ${index}`,Math.floor(index/2)]);
  const latest = await listMessages(history, f.alice);
  const earlier = await listMessages(history, f.alice, latest.messages[0].id);
  assert.equal(latest.hasMore, true); assert.equal(earlier.hasMore, false);
  assert.deepEqual(new Set([...earlier.messages,...latest.messages].map(m=>m.id)), new Set(ids));
  assert.deepEqual((await listMessages(privateId, f.bob)).messages, []);
  assert.deepEqual((await listMessages(history, f.alice, (await createMessage(publicId,f.alice,'Other channel')).id)).messages, [], 'cross-channel cursors reveal nothing');
  await f.db.query('DELETE FROM org_members WHERE org_id=$1 AND user_id=$2',[f.org,f.bob]);
  assert.equal(await loadConversation(dmId,f.bob),null);
  await f.db.query("INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'member')",[f.org,f.bob]);
  assert.equal(await getOrCreateDm(f.org,f.alice,f.bob),dmId,'rejoining and reopening restores the same DM');
  assert.ok(await loadConversation(dmId,f.bob));
  await f.db.query('UPDATE orgs SET deleted_at=now() WHERE id=$1', [f.org]);
  assert.equal(await loadConversation(publicId, f.alice), null);
  console.log('Chat access: public/private/DM isolation, suspension, stale writes and deleted org checks passed.');
} finally { await f.close(); }
