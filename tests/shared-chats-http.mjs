import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {createRun,appendMessage} from '../app/lib/ai/runs.ts';
import {sharedChatBrowser} from './helpers/shared-chat-browser.mjs';

const f=await memoryFixture({postgres:true});let server,logs='';
try {
  await f.db.query('UPDATE users SET email_verified_at=now()');
  const guest=(await f.first(`INSERT INTO users(handle,email,display_name,connect_code,email_verified_at)
    VALUES('guest','guest@example.test','External Guest','PK-GGGG-GGGG',now()) RETURNING id`)).id;
  const tokens=new Map();
  for(const user of [guest,f.alice,f.bob]){
    const token=randomBytes(32).toString('base64url');tokens.set(user,token);
    await f.db.query("INSERT INTO auth_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",[user,createHash('sha256').update(token).digest()]);
  }
  const run=await createRun({sessionId:f.room,startedBy:f.alice,agentId:'codex',baseSha:'a'.repeat(40),title:'Guest invitation review'});
  await appendMessage({runId:run.id,role:'user',authorUserId:f.alice,body:'Review this change'});
  await appendMessage({runId:run.id,role:'agent',body:'## Review\n\nThe change is ready for discussion. No computer connection is needed to read or comment.'});
  await appendMessage({runId:run.id,role:'tool',body:'PRIVATE TOOL OUTPUT'});
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const base=`http://127.0.0.1:${port}`,database=new URL(process.env.DATABASE_URL);
  database.searchParams.set('options',globalThis.__maPool.options.options);
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',String(port)],{env:{...process.env,DATABASE_URL:database.href,REDIS_URL:'',API_TRUST_PROXY:'0',SIGNUP_MODE:'open',GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',GOOGLE_OAUTH_CREDENTIALS_FILE:'',MNEMOSYNE_URL:'',REPO_EMBEDDING_URL:'',WEB_CONCURRENCY:'1'},stdio:['ignore','pipe','pipe']});
  for(const stream of [server.stdout,server.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-8000);});
  let ready=false;for(let i=0;i<150;i++){if(server.exitCode!==null)throw Error(logs);try{ready=(await fetch(base+'/shared')).ok;}catch{}if(ready)break;await delay(100);}assert.ok(ready);
  const api=(path,user,method='GET',body)=>fetch(base+path,{method,headers:{'content-type':'application/json',origin:base,...(user?{cookie:`ma_auth=${tokens.get(user)}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const path=`/api/shared-chats/${run.id}`;
  assert.equal((await api(path,null)).status,401);
  assert.equal((await api(path,guest)).status,403);
  const created=await api(path+'/invitations',f.alice,'POST',{email:'guest@example.test',role:'commenter'});
  assert.equal(created.status,201,await created.clone().text());const invite=await created.json();
  assert.equal((await api(path,f.bob,'POST',{token:invite.token})).status,403);
  assert.equal((await api(path,guest,'POST',{token:invite.token})).status,200);
  const response=await api(path,guest),chat=await response.json();assert.equal(response.status,200);
  assert.equal(chat.messages.length,2);assert.ok(!JSON.stringify(chat).includes('PRIVATE TOOL OUTPUT'));
  assert.match(response.headers.get('cache-control'),/no-store/);
  for(const target of [`/api/sessions/${f.room}`,`/api/sessions/${f.room}/runs`,`/api/sessions/${f.room}/repos`,`/api/sessions/${f.room}/events`,path+'/invitations'])assert.equal((await api(target,guest)).status,403,target);
  assert.equal((await api('/api/orgs/memory/projects',guest)).status,404,'organization existence stays private');
  assert.equal((await api('/api/ai/run',guest,'POST',{sessionId:f.room,runId:run.id,prompt:'Must not execute',agentId:'codex'})).status,403);
  const input={id:randomUUID(),body:'HTTP guest feedback'};
  const posted=await api(path+'/comments',guest,'POST',input);assert.equal(posted.status,201,await posted.clone().text());
  assert.equal((await api(path+'/comments',guest,'POST',input)).status,201);
  assert.equal((await f.first('SELECT count(*)::int AS n FROM shared_chat_comments WHERE id=$1',[input.id])).n,1);
  console.log('PASS: HTTP authentication, email binding, cache policy, idempotent comments, and denial of room/project/file/event/AI access.');
  await sharedChatBrowser({base,runId:run.id,token:invite.token,guestToken:tokens.get(guest),hostToken:tokens.get(f.alice),revoke:async()=>{
    const result=await api(path+'/invitations',f.alice,'DELETE',{id:invite.invitation.id});assert.equal(result.status,200);
  }});
  // The same real HTTP boundaries protect the collaboration workflow.
  const flow=`/api/chats/${run.id}`;
  assert.equal((await api(flow+'/briefing',null)).status,401);
  assert.equal((await api(flow+'/briefing',guest)).status,403);
  assert.equal((await api(flow+'/reviews',guest)).status,403);
  assert.equal((await api(flow+'/feedback',guest)).status,403);
  const draft=await(await api(flow+'/briefing?draft=1',f.alice)).json();
  assert.equal((await api(flow+'/briefing',f.alice,'PUT',{...draft,body:{...draft.body,nextAction:'HTTP updated next action.'}})).status,200);
  assert.equal((await api(flow+'/briefing',f.alice,'PUT',draft)).status,409,'stale edit cannot overwrite');
  const fresh=await(await api(path+'/invitations',f.alice,'POST',{email:'guest@example.test',role:'commenter'})).json();
  await api(path,guest,'POST',{token:fresh.token});
  assert.equal((await api(flow+'/briefing',guest,'PUT',draft)).status,403);
  const feedback=await(await api(flow+'/feedback',f.alice)).json();
  assert.ok(feedback.comments.length>0);
  assert.equal((await api(flow+'/feedback',f.alice,'PUT',{seq:feedback.comments.at(-1).seq})).status,200);
  const preview=await(await api(flow+`/access?invitationId=${fresh.invitation.id}`,f.alice)).json();
  assert.equal(preview.canGrant,true);
  assert.equal((await api(flow+'/access',guest,'POST',{invitationId:fresh.invitation.id,confirm:true})).status,403);
  assert.equal((await api(flow+'/access',f.alice,'POST',{invitationId:fresh.invitation.id})).status,400);
  const granted=await api(flow+'/access',f.alice,'POST',{invitationId:fresh.invitation.id,confirm:true,scopeKey:preview.scopeKey});
  assert.equal(granted.status,200,await granted.clone().text());
  assert.equal((await api(`/api/sessions/${f.room}`,guest)).status,200);
  assert.equal((await f.first('SELECT driver_user_id FROM agent_runs WHERE id=$1',[run.id])).driver_user_id,f.alice);
  const sha='c'.repeat(40);
  await f.db.query("INSERT INTO session_repos(session_id,root_name,base_branch,base_sha_at_fork,session_branch,head_sha) VALUES($1,'fixture','main',$2,'main',$2)",[f.room,sha]);
  await f.db.query("UPDATE agent_runs SET status='completed' WHERE id=$1",[run.id]);
  const review={id:randomUUID(),reviewerId:guest,headSha:sha,note:'Review the saved version.'};
  assert.equal((await api(flow+'/reviews',f.alice,'POST',review)).status,200);
  assert.ok((await(await api('/api/collaboration/inbox',guest)).json()).items.some(item=>item.reviews===1));
  assert.equal((await api(flow+'/reviews',f.alice,'PATCH',{id:review.id,status:'approved',headSha:sha,note:''})).status,403);
  assert.equal((await api(flow+'/reviews',guest,'PATCH',{id:review.id,status:'approved',headSha:sha,note:'Verified.'})).status,200);
  await f.db.query('UPDATE session_repos SET head_sha=$2 WHERE session_id=$1',[f.room,'d'.repeat(40)]);
  assert.equal((await(await api(flow+'/reviews',f.alice)).json()).reviews[0].stale,true);
  console.log('PASS: collaboration HTTP permissions, briefing conflicts, read cursors, explicit guest access grants, review inbox and version-bound approvals.');
}catch(error){console.error(logs);throw error;}
finally{
  if(server?.exitCode===null){server.kill('SIGTERM');await Promise.race([once(server,'exit'),delay(3000)]);}
  await f.close();
}
