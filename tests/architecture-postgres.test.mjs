import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import nextEnv from '@next/env';
import { memoryFixture } from './helpers/memory-fixture.mjs';
import { updateOrgMember, removeOrgMember } from '../app/lib/org/store.ts';
import { createRun } from '../app/lib/ai/runs.ts';
import { reserveTurn, failTurn } from '../app/lib/ai/turns.ts';
import { createChannel, createMessage, ensureMember } from '../app/lib/chat/store.ts';

nextEnv.loadEnvConfig(process.cwd());
const f = await memoryFixture({postgres:true});
try {
  await f.db.query("UPDATE org_members SET role='owner' WHERE org_id=$1 AND user_id=$2", [f.org,f.bob]);
  const results = await Promise.all([
    updateOrgMember(f.org,f.bob,{role:'member'},f.alice),
    updateOrgMember(f.org,f.alice,{role:'member'},f.bob),
  ]);
  assert.equal(results.filter(r=>r.ok).length,1,'only the first authorized demotion succeeds');
  assert.equal((await f.first("SELECT count(*)::int AS n FROM org_members WHERE org_id=$1 AND role='owner' AND status='active'", [f.org])).n,1);
  // Direct database writes also cannot bypass the last-owner backstop.
  await f.db.query("UPDATE org_members SET role='owner' WHERE org_id=$1 AND user_id=ANY($2::uuid[])", [f.org,[f.alice,f.bob]]);
  const direct = await Promise.allSettled([f.alice,f.bob].map(id=>f.db.query("UPDATE org_members SET role='member' WHERE org_id=$1 AND user_id=$2", [f.org,id])));
  assert.equal(direct.filter(r=>r.status==='fulfilled').length,1);
  const rejected = direct.find(r=>r.status==='rejected');
  assert.equal(rejected.reason.code,'23514');
  await f.db.query("UPDATE org_members SET role=CASE WHEN user_id=$2 THEN 'owner' ELSE 'member' END WHERE org_id=$1", [f.org,f.alice]);
  assert.equal((await removeOrgMember(f.org,f.alice,f.bob)).ok,false,'a former owner cannot use stale authority');

  const channel = await createChannel(f.org,f.alice,'concurrent','public');
  await Promise.all(Array.from({length:12},(_,i)=>createMessage(channel,f.bob,`Concurrent ${i}`)));
  assert.equal((await f.first('SELECT count(*)::int AS n FROM chat_messages WHERE conversation_id=$1',[channel])).n,12);
  // Roster changes lock the org before a member. Chat writes must not lock a
  // member and then request a conflicting org lock (the inverse order).
  const adminLock = await globalThis.__maPool.connect();
  try {
    await adminLock.query('BEGIN');
    await adminLock.query('SELECT id FROM orgs WHERE id=$1 FOR NO KEY UPDATE',[f.org]);
    await Promise.race([createMessage(channel,f.bob,'Safe parent lock ordering'),
      new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Chat blocked on org roster lock')),2000);timer.unref();})]);
    await adminLock.query('ROLLBACK');
  } finally { await adminLock.query('ROLLBACK');adminLock.release(); }
  // Let revocation hold the membership lock, then start a stale write. The write
  // must wait and subsequently reject, rather than commit after suspension.
  const tx = await globalThis.__maPool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2",[f.org,f.bob]);
    const blocked = assert.rejects(createMessage(channel,f.bob,'Must not commit'), /access/i);
    await tx.query('COMMIT');
    await blocked;
  } finally { await tx.query('ROLLBACK'); tx.release(); }
  await f.db.query("UPDATE org_members SET status='active' WHERE org_id=$1 AND user_id=$2",[f.org,f.bob]);
  const privateChannel = await createChannel(f.org,f.alice,'private race','private',[f.bob]);
  const revoker=await globalThis.__maPool.connect();
  try {
    await revoker.query('BEGIN');
    await revoker.query('UPDATE conversation_members SET removed_at=now() WHERE conversation_id=$1 AND user_id=$2',[privateChannel,f.bob]);
    const reopening=ensureMember(privateChannel,f.org,f.bob);
    await new Promise(resolve=>setTimeout(resolve,50));
    await revoker.query('COMMIT');
    assert.equal(await reopening,false,'concurrent opening never resurrects revoked private access');
  } finally {await revoker.query('ROLLBACK');revoker.release();}

  const runs=[];
  for (let i=0;i<12;i++) {
    const room=`quotaroomxx${String.fromCharCode(97+i)}`;
    const project = (await f.first(`INSERT INTO projects(org_id,slug,name,created_by) VALUES ($1,$2::text,$2::text,$3) RETURNING id`,[f.org,`quota-${i}`,f.alice])).id;
    await f.db.query(`INSERT INTO sessions(id,owner_id,org_id,project_id,name,join_code,visibility)
      VALUES ($1,$2,$3,$4,$1,'ABCD-EFGH','public')`,[room,f.alice,f.org,project]);
    runs.push(await createRun({sessionId:room,startedBy:f.alice,agentId:'codex',baseSha:'a'.repeat(40)}));
  }
  await f.db.query('UPDATE orgs SET run_concurrency_limit=20,run_monthly_quota=1 WHERE id=$1',[f.org]);
  const attempts = runs.map(run=>({run,turn:randomUUID()}));
  const admissions = await Promise.allSettled(attempts.map(({run,turn})=>reserveTurn(run.id,f.alice,turn,0)));
  assert.equal(admissions.filter(r=>r.status==='fulfilled').length,1,'one remaining monthly turn cannot be oversubscribed');
  for (const result of admissions.filter(r=>r.status==='rejected')) assert.equal(result.reason.status,429);
  for (const {turn} of attempts) await failTurn(turn,'Fixture cleanup');
  assert.equal((await f.first('SELECT count(*)::int AS n FROM agent_turns')).n,1);
  console.log('PostgreSQL: owner write skew, stale admin authority, concurrent chat writes, suspension and 12-way quota admission passed.');
} finally { await f.close(); }
