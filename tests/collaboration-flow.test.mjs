import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {createRun,appendMessage} from '../app/lib/ai/runs.ts';
import {readBriefing,saveBriefing} from '../app/lib/collaboration/briefing.ts';
import {requestReview,listReviews,resolveReview} from '../app/lib/collaboration/reviews.ts';
import {readFeedback,markFeedbackRead,collaborationInbox} from '../app/lib/collaboration/feedback.ts';
import {previewGuestAccess,grantGuestAccess,requestGuestAccess,listGuestAccessRequests,declineGuestAccess} from '../app/lib/collaboration/promotion.ts';
import {createChatInvitation,acceptChatInvitation,addSharedComment,revokeChatInvitation,readSharedChat} from '../app/lib/sharing/store.ts';
import {changeHandoff,handoffState} from '../app/lib/ai/handoff.ts';

const postgres=process.env.COLLABORATION_TEST_POSTGRES==='1';
const f=await memoryFixture({postgres});
const denied=(promise,status=403)=>assert.rejects(promise,error=>error.status===status);
try {
  await f.db.query('UPDATE users SET email_verified_at=now()');
  await f.db.query("UPDATE project_members SET role='editor' WHERE user_id=$1",[f.bob]);
  const sha='a'.repeat(40),nextSha='b'.repeat(40);
  await f.db.query("INSERT INTO session_repos(session_id,root_name,base_branch,base_sha_at_fork,session_branch,head_sha) VALUES($1,'fixture','main',$2,'main',$2)",[f.room,sha]);
  const run=await createRun({sessionId:f.room,startedBy:f.alice,agentId:'codex',baseSha:sha,title:'Verification feature'});
  await f.db.query("UPDATE agent_runs SET status='completed' WHERE id=$1",[run.id]);
  await appendMessage({runId:run.id,role:'user',authorUserId:f.alice,body:'Verify email addresses once.'});
  await appendMessage({runId:run.id,role:'tool',body:'PRIVATE TOOL OUTPUT'});
  await appendMessage({runId:run.id,role:'agent',body:'Implementation written; tests still need to run.'});
  const guest=(await f.first(`INSERT INTO users(handle,email,display_name,connect_code,email_verified_at)
    VALUES('guest','guest@flow.test','Guest','PK-FFFF-GGGG',now()) RETURNING id`)).id;
  const invitation=await createChatInvitation(run.id,f.alice,{email:'guest@flow.test',role:'commenter'});
  await acceptChatInvitation(run.id,guest,invitation.token);

  // Briefings keep private records out of guest drafts; proposals are not facts.
  const memory=(await f.first(`INSERT INTO memory_records(room_id,kind,text,status,source_run_id,dedupe_key)
    VALUES($1,'fact','APPROVED INTERNAL DECISION','approved',$2,'flow-decision') RETURNING id`,[f.room,run.id])).id;
  await f.db.query(`INSERT INTO memory_records(room_id,kind,text,status,source_run_id,dedupe_key)
    VALUES($1,'fact','UNAPPROVED PROPOSAL','proposed',$2,'flow-proposal')`,[f.room,run.id]);
  let briefing=await readBriefing(run.id,f.alice);
  assert.equal(briefing.body.goal,'Verify email addresses once.');
  assert.ok(briefing.body.decisions.includes('APPROVED INTERNAL DECISION'));
  assert.ok(!JSON.stringify(briefing).includes('UNAPPROVED PROPOSAL'));
  assert.ok(!JSON.stringify(briefing).includes('PRIVATE TOOL OUTPUT'));
  assert.ok(briefing.body.progress.includes('verify before relying'));
  const guestDraft=await readBriefing(run.id,guest);
  assert.equal(guestDraft.canEdit,false);assert.equal(guestDraft.headSha,null);
  assert.ok(!JSON.stringify(guestDraft).includes('APPROVED INTERNAL DECISION'));
  await denied(saveBriefing(run.id,guest,briefing));
  await denied(listReviews(run.id,guest));
  let saved=await saveBriefing(run.id,f.alice,{...briefing,body:{...briefing.body,nextAction:'Run delivery failure tests.'}});
  assert.equal(saved.revision,1);
  await denied(saveBriefing(run.id,f.alice,briefing),409);
  assert.equal((await readBriefing(run.id,guest)).revision,0);
  saved=await saveBriefing(run.id,f.alice,{...saved,sharedWithGuests:true});
  assert.equal((await readBriefing(run.id,guest)).body.nextAction,'Run delivery failure tests.');
  assert.equal((await readBriefing(run.id,f.bob)).canEdit,false,'published briefing is managed by its host');
  assert.equal((await readBriefing(run.id,f.bob)).canPublish,false);
  await denied(saveBriefing(run.id,f.bob,saved));
  await appendMessage({runId:run.id,role:'user',authorUserId:f.alice,body:'Also test expired codes.'});
  assert.equal((await readBriefing(run.id,f.alice)).stale,true);
  await denied(saveBriefing(run.id,f.alice,saved),409);
  briefing=await readBriefing(run.id,f.alice,true);
  const saves=await Promise.allSettled([saveBriefing(run.id,f.alice,briefing),saveBriefing(run.id,f.alice,briefing)]);
  assert.equal(saves.filter(s=>s.status==='fulfilled').length,1,'one briefing revision wins');
  await f.db.query("UPDATE memory_records SET status='retracted',valid_to=now(),revision=revision+1 WHERE id=$1",[memory]);
  assert.equal((await readBriefing(run.id,f.alice)).stale,true,'decision changes stale the briefing');

  // Review request retries, authority, immutable commit binding and stale approval.
  const request={id:randomUUID(),reviewerId:f.bob,headSha:sha,note:'Inspect verification failures.'};
  await Promise.all(Array.from({length:6},()=>requestReview(run.id,f.alice,request)));
  assert.equal((await listReviews(run.id,f.alice)).reviews.length,1);
  await denied(requestReview(run.id,f.alice,{...request,id:randomUUID(),note:'Different instructions must not silently replace the pending request.'}),409);
  await denied(requestReview(run.id,f.alice,{...request,id:randomUUID(),reviewerId:guest}));
  await denied(requestReview(run.id,f.alice,{...request,id:randomUUID(),reviewerId:f.alice}),400);
  await denied(resolveReview(run.id,f.alice,{id:request.id,status:'approved',headSha:sha,note:''}));
  if(postgres) {
    const holder=await globalThis.__maPool.connect();
    try {
      await holder.query('BEGIN');
      const {rows:[{pid}]}=await holder.query('SELECT pg_backend_pid() AS pid');
      await holder.query('UPDATE session_repos SET head_sha=$2 WHERE session_id=$1',[f.room,nextSha]);
      const approval=resolveReview(run.id,f.bob,{id:request.id,status:'approved',headSha:sha,note:''}).then(()=>({ok:true}),error=>({ok:false,error}));
      let blocked=false;
      for(let i=0;i<100&&!blocked;i++) {blocked=(await f.first('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).blocked;if(!blocked)await delay(20);}
      assert.equal(blocked,true,'approval waited for the commit row');
      await holder.query('COMMIT');
      const outcome=await approval;
      assert.equal(outcome.ok,false);assert.equal(outcome.error.status,409,'approval rechecks the head after its lock wait');
    } finally {await holder.query('ROLLBACK');holder.release();}
  } else await f.db.query('UPDATE session_repos SET head_sha=$2 WHERE session_id=$1',[f.room,nextSha]);
  await denied(resolveReview(run.id,f.bob,{id:request.id,status:'approved',headSha:sha,note:''}),409);
  assert.equal((await listReviews(run.id,f.bob)).reviews[0].stale,true);
  const current={...request,id:randomUUID(),headSha:nextSha};await requestReview(run.id,f.alice,current);
  await resolveReview(run.id,f.bob,{id:current.id,status:'approved',headSha:nextSha,note:'Reviewed the saved changes.'});
  await resolveReview(run.id,f.bob,{id:current.id,status:'approved',headSha:nextSha,note:'Reviewed the saved changes.'});
  await f.db.query('UPDATE session_repos SET head_sha=$2 WHERE session_id=$1',[f.room,sha]);
  assert.equal((await listReviews(run.id,f.alice)).reviews.find(r=>r.id===current.id).stale,true,'old approval cannot approve new code');
  for(let i=0;i<52;i++)await f.db.query(`INSERT INTO chat_reviews(id,run_id,requested_by,reviewer_id,head_sha,base_sha,status,resolved_at)
    VALUES($1,$2,$3,$4,$5,$5,'approved',now())`,[randomUUID(),run.id,f.alice,f.bob,sha]);
  const firstReviews=await listReviews(run.id,f.alice),olderReviews=await listReviews(run.id,f.alice,50);
  assert.equal(firstReviews.hasMore,true);assert.equal(olderReviews.hasMore,false);
  assert.equal(firstReviews.reviews[0].id,request.id,'pending review appears before completed history');
  assert.equal(new Set([...firstReviews.reviews,...olderReviews.reviews].map(r=>r.id)).size,54);

  // Feedback stays separate from AI, unread state survives refresh, and a stale
  // cursor cannot mark later comments read. Equal timestamps do not lose pages.
  await addSharedComment(run.id,guest,{id:randomUUID(),body:'Please test delivery errors.'});
  assert.equal((await collaborationInbox(f.alice)).items.find(i=>i.runId===run.id).unread,1);
  let feedback=await readFeedback(run.id,f.alice);const displayed=feedback.comments.at(-1).seq;
  await addSharedComment(run.id,guest,{id:randomUUID(),body:'And expired codes.'});
  await markFeedbackRead(run.id,f.alice,displayed);
  assert.equal((await collaborationInbox(f.alice)).items.find(i=>i.runId===run.id).unread,1);
  await addSharedComment(run.id,f.bob,{id:randomUUID(),body:'I can help with that.'});
  for(let i=0;i<54;i++)await addSharedComment(run.id,guest,{id:randomUUID(),body:`Feedback ${i}`});
  feedback=await readFeedback(run.id,f.alice);
  assert.equal(feedback.hasMore,true);
  const older=await readFeedback(run.id,f.alice,feedback.comments[0].seq);
  assert.equal(new Set([...older.comments,...feedback.comments].map(c=>c.id)).size,57);
  await markFeedbackRead(run.id,f.alice,feedback.comments.at(-1).seq);
  await markFeedbackRead(run.id,f.alice,displayed);
  assert.equal((await collaborationInbox(f.alice)).items.length,0);
  assert.equal((await f.first('SELECT count(*)::int AS n FROM agent_turns WHERE run_id=$1',[run.id])).n,0);

  // A host who lacks organization admin rights cannot grant outsiders org access.
  await f.db.query('UPDATE agent_runs SET driver_user_id=$2 WHERE id=$1',[run.id,f.bob]);
  const bobPreview=await previewGuestAccess(run.id,f.bob,invitation.invitation.id);
  assert.equal(bobPreview.canGrant,false);
  await denied(grantGuestAccess(run.id,f.bob,{invitationId:invitation.invitation.id,confirm:true}));
  await f.db.query('UPDATE agent_runs SET driver_user_id=$2 WHERE id=$1',[run.id,f.alice]);
  const preview=await previewGuestAccess(run.id,f.alice,invitation.invitation.id);
  assert.equal(preview.canGrant,true);assert.equal(preview.alreadyEditor,false);
  await denied(grantGuestAccess(run.id,f.alice,{invitationId:invitation.invitation.id}),400);
  await denied(grantGuestAccess(run.id,f.alice,{invitationId:invitation.invitation.id,confirm:true,scopeKey:'old-scope'}),409);
  await Promise.all(Array.from({length:4},()=>grantGuestAccess(run.id,f.alice,{invitationId:invitation.invitation.id,confirm:true,scopeKey:preview.scopeKey})));
  assert.equal((await f.first('SELECT room_access_role($1,$2) AS role',[f.room,guest])).role,'editor');
  assert.equal((await f.first('SELECT role FROM org_members WHERE org_id=$1 AND user_id=$2',[f.org,guest])).role,'member');
  assert.equal((await f.first('SELECT driver_user_id FROM agent_runs WHERE id=$1',[run.id])).driver_user_id,f.alice,'grant is not handoff');
  assert.equal((await f.first('SELECT count(*)::int AS n FROM chat_access_grants')).n,1);
  assert.ok((await readSharedChat(run.id,guest)).workspacePath.includes(f.room));
  await changeHandoff(run.id,f.room,f.alice,{action:'offer',toUserId:guest,note:'Continue from the briefing.',version:0});
  const offer=(await handoffState(run.id,f.room)).offers[0];
  await changeHandoff(run.id,f.room,guest,{action:'accept',handoffId:offer.id,version:0});
  assert.equal((await f.first('SELECT driver_user_id FROM agent_runs WHERE id=$1',[run.id])).driver_user_id,guest);
  // Removing editing access must not be undone by replaying the old grant.
  await f.db.query('UPDATE session_members SET removed_at=now() WHERE session_id=$1 AND user_id=$2',[f.room,guest]);
  await denied(grantGuestAccess(run.id,f.alice,{invitationId:invitation.invitation.id,confirm:true}));
  await f.db.query("UPDATE org_members SET status='suspended' WHERE org_id=$1 AND user_id=$2",[f.org,guest]);
  await denied(readBriefing(run.id,guest));await denied(readFeedback(run.id,guest));
  await denied(grantGuestAccess(run.id,f.alice,{invitationId:invitation.invitation.id,confirm:true}));
  await revokeChatInvitation(run.id,f.alice,invitation.invitation.id);
  assert.equal((await collaborationInbox(guest)).items.length,0);
  // A private workspace owner can explicitly ask an admin to approve an outsider.
  // The request exposes metadata only; it never gives the admin the transcript.
  await f.db.query("UPDATE sessions SET visibility='private' WHERE id=$1",[f.other]);
  const privateRun=await createRun({sessionId:f.other,startedBy:f.bob,agentId:'codex',baseSha:sha,title:'Private collaboration'});
  const secondGuest=(await f.first(`INSERT INTO users(handle,email,display_name,connect_code,email_verified_at)
    VALUES('secondguest','second@flow.test','Second guest','PK-HHHH-JJJJ',now()) RETURNING id`)).id;
  const secondInvitation=await createChatInvitation(privateRun.id,f.bob,{email:'second@flow.test',role:'commenter'});
  await acceptChatInvitation(privateRun.id,secondGuest,secondInvitation.token);
  const secondId=secondInvitation.invitation.id;
  await denied(previewGuestAccess(privateRun.id,f.alice,secondId));
  const requestPreview=await previewGuestAccess(privateRun.id,f.bob,secondId);
  assert.equal(requestPreview.canRequest,true);assert.equal(requestPreview.canGrant,false);
  const accessInput={invitationId:secondId,confirm:true,scopeKey:requestPreview.scopeKey};
  await denied(requestGuestAccess(privateRun.id,f.bob,{...accessInput,confirm:false}),400);
  await requestGuestAccess(privateRun.id,f.bob,accessInput);
  assert.equal((await listGuestAccessRequests(f.alice)).items.length,1);
  assert.equal((await listGuestAccessRequests(f.bob)).items.length,0);
  await denied(readBriefing(privateRun.id,f.alice));
  await denied(declineGuestAccess(privateRun.id,f.bob,secondId));
  await declineGuestAccess(privateRun.id,f.alice,secondId);
  assert.equal((await listGuestAccessRequests(f.alice)).items.length,0);
  await requestGuestAccess(privateRun.id,f.bob,accessInput);
  assert.equal((await previewGuestAccess(privateRun.id,f.alice,secondId)).canGrant,true);
  await f.db.query("UPDATE projects SET name='Renamed project' WHERE id=$1",[f.project]);
  assert.equal((await previewGuestAccess(privateRun.id,f.alice,secondId)).canGrant,false,'changed scope requires new owner consent');
  const updatedPreview=await previewGuestAccess(privateRun.id,f.bob,secondId);
  await requestGuestAccess(privateRun.id,f.bob,{...accessInput,scopeKey:updatedPreview.scopeKey});
  await grantGuestAccess(privateRun.id,f.alice,{...accessInput,scopeKey:updatedPreview.scopeKey});
  assert.equal((await listGuestAccessRequests(f.alice)).items.length,0);
  assert.equal((await f.first('SELECT room_access_role($1,$2) AS role',[f.other,secondGuest])).role,'editor');
  await denied(readBriefing(privateRun.id,f.alice));
  assert.equal((await f.first('SELECT driver_user_id FROM agent_runs WHERE id=$1',[privateRun.id])).driver_user_id,f.bob);
  console.log(`PASS (${postgres?'PostgreSQL':'PGlite'}): evidence-backed briefings, concurrent saves, versioned reviews, unread feedback, scoped guest grants and handoff.`);
} finally {await f.close();}
