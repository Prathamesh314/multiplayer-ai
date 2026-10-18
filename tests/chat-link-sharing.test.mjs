// Sharing a chat like a document: people added by email open it without a
// token, and "anyone with the link" reads it without an account. Both end
// when the host removes them or can no longer share.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {createRun,appendMessage} from '../app/lib/ai/runs.ts';
import {getSession} from '../app/lib/session/store.ts';
import {addSharedComment,createChatInvitation,getChatLink,listChatInvitations,listSharedChats,readSharedChat,revokeChatInvitation,setChatLink} from '../app/lib/sharing/store.ts';

const denied=(work,message)=>assert.rejects(work,error=>error.status===403,message);

test('people added by email open the chat with their verified email, until removed', async () => {
  const f=await memoryFixture();
  try {
    await f.db.query('UPDATE users SET email_verified_at=now()');
    const guest=(await f.first(`INSERT INTO users(handle,email,display_name,connect_code,email_verified_at)
      VALUES('guest','guest@example.test','Guest','PK-GGGG-GGGG',now()) RETURNING id`)).id;
    const run=await createRun({sessionId:f.room,startedBy:f.alice,agentId:'codex',baseSha:'a'.repeat(40),title:'Shared review'});
    await appendMessage({runId:run.id,role:'user',authorUserId:f.alice,body:'Review this change'});
    await denied(readSharedChat(run.id,guest));
    const {invitation,token}=await createChatInvitation(run.id,f.alice,{email:'Guest@Example.test',role:'commenter'},'email');
    assert.equal(token,null);assert.equal(invitation.expiresAt,null);assert.equal(invitation.viaLink,false);
    assert.equal((await f.first('SELECT token_hash FROM chat_invitations WHERE id=$1',[invitation.id])).token_hash,null);
    await denied(readSharedChat(run.id,f.outsider),'another account is not the invited email');
    await f.db.query('UPDATE users SET email_verified_at=NULL WHERE id=$1',[guest]);
    await denied(readSharedChat(run.id,guest),'unverified email');
    await f.db.query('UPDATE users SET email_verified_at=now() WHERE id=$1',[guest]);
    const chat=await readSharedChat(run.id,guest);
    assert.deepEqual([chat.role,chat.signedIn,chat.viaLink],['commenter',true,false]);
    assert.ok((await listChatInvitations(run.id,f.alice))[0].acceptedAt,'shown to the host as opened');
    assert.deepEqual((await listSharedChats(guest)).map((item)=>item.id),[run.id]);
    assert.equal((await getSession(f.room,guest)).myRole,null,'never room access');
    await addSharedComment(run.id,guest,{id:randomUUID(),body:'Looks good'});
    // Changing the role replaces the grant; removing it ends access.
    const viewer=(await createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'viewer'},'email')).invitation;
    assert.equal((await readSharedChat(run.id,guest)).role,'viewer');
    await denied(addSharedComment(run.id,guest,{id:randomUUID(),body:'Viewers cannot comment'}));
    await revokeChatInvitation(run.id,f.alice,viewer.id);
    await denied(readSharedChat(run.id,guest));
  } finally { await f.close(); }
});

test('anyone with the link reads without an account, and the link ends with its creator access', async () => {
  const f=await memoryFixture();
  try {
    await f.db.query('UPDATE users SET email_verified_at=now()');
    const run=await createRun({sessionId:f.room,startedBy:f.alice,agentId:'codex',baseSha:'a'.repeat(40),title:'Public review'});
    await appendMessage({runId:run.id,role:'user',authorUserId:f.alice,body:'Review this change'});
    await appendMessage({runId:run.id,role:'tool',body:'PRIVATE TOOL OUTPUT'});
    assert.equal(await getChatLink(run.id,f.alice),null,'restricted by default');
    await denied(setChatLink(run.id,f.bob,'viewer'));
    await assert.rejects(setChatLink(run.id,f.alice,'owner'),error=>error.status===400);
    const link=await setChatLink(run.id,f.alice,'viewer');
    await denied(readSharedChat(run.id,null),'no link, no access');
    await denied(readSharedChat(run.id,null,0,undefined,'z'.repeat(43)));
    const open=await readSharedChat(run.id,null,0,undefined,link.token);
    assert.deepEqual([open.role,open.signedIn,open.viaLink,open.messages.length,open.workspacePath],['viewer',false,true,1,undefined]);
    assert.ok(!JSON.stringify(open).includes('PRIVATE TOOL OUTPUT'));
    await denied(addSharedComment(run.id,f.outsider,{id:randomUUID(),body:'View only'},link.token));
    assert.equal((await setChatLink(run.id,f.alice,'commenter')).token,link.token,'same link, new role');
    await addSharedComment(run.id,f.outsider,{id:randomUUID(),body:'Signed in, through the link'},link.token);
    assert.equal((await readSharedChat(run.id,f.alice,0,undefined,link.token)).role,'manager','the strongest access wins');
    // The creator is removed from the project: their link stops working.
    await f.db.query(`UPDATE project_members SET removed_at=now() WHERE project_id=$1 AND user_id=$2`,[f.project,f.alice]);
    await denied(readSharedChat(run.id,null,0,undefined,link.token));
    await f.db.query(`UPDATE project_members SET removed_at=NULL WHERE project_id=$1 AND user_id=$2`,[f.project,f.alice]);
    assert.equal((await readSharedChat(run.id,null,0,undefined,link.token)).role,'commenter','back when they are');
    await f.db.query(`UPDATE sessions SET deleted_at=now() WHERE id=$1`,[f.room]);
    await denied(readSharedChat(run.id,null,0,undefined,link.token),'a deleted room ends the link');
    await f.db.query(`UPDATE sessions SET deleted_at=NULL WHERE id=$1`,[f.room]);
    assert.equal(await setChatLink(run.id,f.alice,null),null);
    await denied(readSharedChat(run.id,null,0,undefined,link.token),'restricted again');
  } finally { await f.close(); }
});

test('an Editor becomes an editor of the room on first open, under the host’s authority', async () => {
  const { grantInvitedEditor } = await import('../app/lib/collaboration/promotion.ts');
  const { pendingEditorInvitation } = await import('../app/lib/sharing/store.ts');
  const f=await memoryFixture();
  try {
    await f.db.query('UPDATE users SET email_verified_at=now()');
    const guest=(await f.first(`INSERT INTO users(handle,email,display_name,connect_code,email_verified_at)
      VALUES('guest','guest@example.test','Guest','PK-GGGG-GGGG',now()) RETURNING id`)).id;
    const run=await createRun({sessionId:f.room,startedBy:f.alice,agentId:'codex',baseSha:'a'.repeat(40),title:'Pair on it'});
    await appendMessage({runId:run.id,role:'user',authorUserId:f.alice,body:'Continue from here'});
    await assert.rejects(createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'editor'}),e=>e.status===400,'not through one-time invitation links');
    await assert.rejects(setChatLink(run.id,f.alice,'editor'),e=>e.status===400,'never for anyone with the link');
    await createChatInvitation(run.id,f.alice,{email:'guest@example.test',role:'editor'},'email');
    const opened=await readSharedChat(run.id,guest);
    assert.equal(opened.role,'editor');
    assert.equal(opened.workspacePath,undefined,'no room access before the grant');
    await addSharedComment(run.id,guest,{id:randomUUID(),body:'On it'});
    const invitation=await pendingEditorInvitation(run.id,guest);
    assert.ok(invitation);
    assert.deepEqual(await grantInvitedEditor(run.id,invitation),{granted:true},'Alice owns the organisation, so her Editor choice is enough');
    assert.equal((await getSession(f.room,guest)).myRole,'editor');
    assert.equal((await f.first('SELECT status FROM org_members WHERE org_id=$1 AND user_id=$2',[f.org,guest])).status,'active');
    assert.equal((await f.first('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2',[f.project,guest])).role,'editor');
    assert.ok((await readSharedChat(run.id,guest)).workspacePath,'can open the workspace now');
    assert.equal(await pendingEditorInvitation(run.id,guest),null,'granted once');
    assert.equal((await listChatInvitations(run.id,f.alice))[0].workspaceAccess,true);
  } finally { await f.close(); }
});

test('without the authority to grant it, an Editor can read and comment until an admin approves', async () => {
  const { grantInvitedEditor } = await import('../app/lib/collaboration/promotion.ts');
  const { pendingEditorInvitation } = await import('../app/lib/sharing/store.ts');
  const f=await memoryFixture();
  try {
    await f.db.query('UPDATE users SET email_verified_at=now()');
    const guest=(await f.first(`INSERT INTO users(handle,email,display_name,connect_code,email_verified_at)
      VALUES('guest','guest@example.test','Guest','PK-GGGG-GGGG',now()) RETURNING id`)).id;
    await f.db.query(`UPDATE project_members SET role='editor' WHERE user_id=$1`,[f.bob]);
    const run=await createRun({sessionId:f.other,startedBy:f.bob,agentId:'codex',baseSha:'a'.repeat(40)});
    await createChatInvitation(run.id,f.bob,{email:'guest@example.test',role:'editor'},'email');
    assert.equal((await readSharedChat(run.id,guest)).role,'editor');
    const outcome=await grantInvitedEditor(run.id,await pendingEditorInvitation(run.id,guest));
    assert.equal(outcome.granted,false);
    assert.match(outcome.reason,/organization owner or admin/);
    assert.equal((await getSession(f.other,guest)).myRole,null,'no room access was added');
    await addSharedComment(run.id,guest,{id:randomUUID(),body:'Still here to help'});
  } finally { await f.close(); }
});
