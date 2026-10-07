import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {createRun,appendMessage} from '../app/lib/ai/runs.ts';
import {getSession} from '../app/lib/session/store.ts';
import {createChatInvitation,acceptChatInvitation,readSharedChat,addSharedComment,revokeChatInvitation,listSharedChats} from '../app/lib/sharing/store.ts';

const postgres=process.env.SHARING_TEST_POSTGRES==='1';
const f=await memoryFixture({postgres});
try {
  await f.db.query('UPDATE users SET email_verified_at=now()');
  const guest=(await f.first(`INSERT INTO users(handle,email,display_name,connect_code,email_verified_at)
    VALUES('guest','guest@example.test','Guest','PK-GGGG-GGGG',now()) RETURNING id`)).id;
  const run=await createRun({sessionId:f.room,startedBy:f.alice,agentId:'codex',baseSha:'a'.repeat(40),title:'Shared review'});
  const other=await createRun({sessionId:f.other,startedBy:f.bob,agentId:'codex',baseSha:'b'.repeat(40)});
  await appendMessage({runId:run.id,role:'user',authorUserId:f.alice,body:'Review this change'});
  await appendMessage({runId:run.id,role:'tool',body:'PRIVATE TOOL OUTPUT'});
  await appendMessage({runId:run.id,role:'agent',body:'Here is my review'});
  const denied=work=>assert.rejects(work,error=>error.status===403);
  await denied(readSharedChat(run.id,guest));
  await denied(createChatInvitation(run.id,f.bob,{email:'guest@example.test',role:'commenter'}));
  await assert.rejects(createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'owner'}),error=>error.status===400);
  const invite=await createChatInvitation(run.id,f.alice,{email:' GUEST@example.test ',role:'viewer'});
  assert.equal((await f.first('SELECT token_hash FROM chat_invitations WHERE id=$1',[invite.invitation.id])).token_hash.length,32);
  await denied(acceptChatInvitation(run.id,f.bob,invite.token));
  await denied(acceptChatInvitation(other.id,guest,invite.token));
  await f.db.query('UPDATE users SET email_verified_at=NULL WHERE id=$1',[guest]);
  await denied(acceptChatInvitation(run.id,guest,invite.token));
  await f.db.query('UPDATE users SET email_verified_at=now() WHERE id=$1',[guest]);
  await Promise.all(Array.from({length:8},()=>acceptChatInvitation(run.id,guest,invite.token)));
  const chat=await readSharedChat(run.id,guest);
  assert.equal(chat.role,'viewer');assert.equal(chat.messages.length,2);assert.ok(!JSON.stringify(chat).includes('PRIVATE TOOL'));
  for (const key of ['sessionId','repoId','baseSha','error','joinCode']) assert.equal(chat[key],undefined);
  assert.equal((await getSession(f.room,guest)).myRole,null,'invitation never grants room access');
  for (const table of ['org_members','project_members','session_members','agent_run_participants']) {
    assert.equal((await f.first(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`,[guest])).n,0,table);
  }
  await denied(readSharedChat(other.id,guest));
  await denied(addSharedComment(run.id,guest,{id:randomUUID(),body:'Not allowed'}));
  assert.deepEqual((await listSharedChats(guest)).map(c=>c.id),[run.id]);
  const commentInvite=await createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'commenter'});
  await denied(acceptChatInvitation(run.id,guest,invite.token));
  await acceptChatInvitation(run.id,guest,commentInvite.token);
  const input={id:randomUUID(),body:'Please explain the test coverage.'};
  await Promise.all(Array.from({length:12},()=>addSharedComment(run.id,guest,input)));
  assert.equal((await readSharedChat(run.id,guest)).comments.length,1,'retry is idempotent');
  await assert.rejects(addSharedComment(run.id,guest,{...input,body:'Changed request'}),error=>error.status===409);
  assert.equal((await f.first('SELECT count(*)::int AS n FROM agent_turns WHERE run_id=$1',[run.id])).n,0,'comment never starts AI');
  await addSharedComment(run.id,f.alice,{id:randomUUID(),body:'I will review it.'});
  const reduced=await createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'viewer'});
  await denied(addSharedComment(run.id,guest,{id:randomUUID(),body:'Old permission'}));
  await acceptChatInvitation(run.id,guest,reduced.token);
  assert.equal((await readSharedChat(run.id,guest)).role,'viewer');
  await revokeChatInvitation(run.id,f.alice,reduced.invitation.id);
  await denied(readSharedChat(run.id,guest));
  await denied(acceptChatInvitation(run.id,guest,reduced.token));
  assert.deepEqual(await listSharedChats(guest),[]);
  const expired=await createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'viewer'});
  await f.db.query("UPDATE chat_invitations SET created_at=now()-interval '8 days',expires_at=now()-interval '1 day' WHERE id=$1",[expired.invitation.id]);
  await denied(acceptChatInvitation(run.id,guest,expired.token));
  const active=await createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'commenter'});
  await acceptChatInvitation(run.id,guest,active.token);
  await f.db.query("INSERT INTO org_members(org_id,user_id,role) VALUES($1,$2,'member')",[f.org,guest]);
  await f.db.query("UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2",[f.org,guest]);
  await denied(readSharedChat(run.id,guest));
  await f.db.query("UPDATE org_members SET status='active' WHERE org_id=$1 AND user_id=$2",[f.org,guest]);
  await denied(readSharedChat(run.id,guest),'unsuspending does not restore revoked grants');
  await f.db.query('DELETE FROM org_members WHERE org_id=$1 AND user_id=$2',[f.org,guest]);
  const removed=await createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'viewer'});
  await denied(acceptChatInvitation(run.id,guest,removed.token));
  await f.db.query("INSERT INTO org_members(org_id,user_id,role) VALUES($1,$2,'member')",[f.org,guest]);
  await acceptChatInvitation(run.id,guest,removed.token);
  await f.db.query("INSERT INTO project_members(project_id,org_id,user_id,role) VALUES($1,$2,$3,'viewer')",[f.project,f.org,guest]);
  await f.db.query('UPDATE project_members SET removed_at=now() WHERE project_id=$1 AND user_id=$2',[f.project,guest]);
  await denied(readSharedChat(run.id,guest));
  await f.db.query('UPDATE project_members SET removed_at=NULL WHERE project_id=$1 AND user_id=$2',[f.project,guest]);
  await f.db.query('UPDATE users SET deleted_at=now() WHERE id=$1',[guest]);
  await denied(readSharedChat(run.id,guest));
  await f.db.query('UPDATE users SET deleted_at=NULL WHERE id=$1',[guest]);
  await f.db.query('UPDATE orgs SET deleted_at=now() WHERE id=$1',[f.org]);
  await denied(readSharedChat(run.id,guest));
  await f.db.query('UPDATE orgs SET deleted_at=NULL WHERE id=$1',[f.org]);

  // Paging is scoped and complete even when several comments share a timestamp.
  for(let i=0;i<105;i++) {
    await appendMessage({runId:run.id,role:'agent',body:`Page ${i}`});
    await addSharedComment(run.id,f.alice,{id:randomUUID(),body:`Comment ${i}`});
  }
  const page1=await readSharedChat(run.id,guest),page2=await readSharedChat(run.id,guest,page1.messages.at(-1).seq,page1.comments[0].id);
  assert.equal(page1.hasMore,true);assert.equal(page2.hasMore,false);
  assert.equal(new Set([...page1.messages,...page2.messages].map(m=>m.id)).size,107);
  assert.equal(new Set([...page1.comments,...page2.comments].map(m=>m.id)).size,107);

  if(postgres) {
    // Keep the revocation transaction open. A stale acceptance must wait on
    // the same run lock, then reject after the revoke commits.
    const racing=await createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'commenter'});
    const tx=await globalThis.__maPool.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('SELECT id FROM agent_runs WHERE id=$1 FOR NO KEY UPDATE',[run.id]);
      await tx.query('UPDATE chat_invitations SET revoked_at=now() WHERE id=$1',[racing.invitation.id]);
      const attempt=denied(acceptChatInvitation(run.id,guest,racing.token));
      await tx.query('COMMIT');await attempt;
    }finally{await tx.query('ROLLBACK');tx.release();}
    const races=await Promise.all(Array.from({length:8},()=>createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'viewer'})));
    assert.equal((await f.first('SELECT count(*)::int AS n FROM chat_invitations WHERE run_id=$1 AND email=$2 AND revoked_at IS NULL',[run.id,'guest@example.test'])).n,1);
    assert.equal(races.length,8);
    const pending=await createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'commenter'});
    await acceptChatInvitation(run.id,guest,pending.token);
    const suspender=await globalThis.__maPool.connect();
    try{
      await suspender.query('BEGIN');
      await suspender.query("UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2",[f.org,guest]);
      const attempt=denied(addSharedComment(run.id,guest,{id:randomUUID(),body:'Must not commit after suspension'}));
      await suspender.query('COMMIT');await attempt;
    }finally{await suspender.query('ROLLBACK');suspender.release();}
    assert.equal((await f.first("SELECT count(*)::int AS n FROM shared_chat_comments WHERE body='Must not commit after suspension'")).n,0);
  }
  console.log(`PASS (${postgres?'PostgreSQL':'PGlite'}): outsider access, email binding, role isolation, idempotency, revocation, expiry, membership removal, deleted resources, pagination and concurrent invitations.`);
}finally{await f.close();}
