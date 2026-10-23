import assert from 'node:assert/strict';
import {test} from 'node:test';
import {finishDesktopSignIn} from '../app/lib/auth/desktop-sign-in.ts';
import {AuthRequestError} from '../app/lib/auth/request.ts';

function fixture(t) {
  const calls={redeem:0,ticket:0,reload:0,activate:[]},attempt={id:'approval',verifier:'private-proof'};
  const session={id:'sess_desktop',status:'active',user:{id:'user_approved'}};
  const clerk={client:{sessions:[],async reload(){calls.reload++;return this;},signIn:{async create(params){
    calls.ticket++;assert.deepEqual(params,{strategy:'ticket',ticket:'private-ticket'});
    clerk.client.sessions.push(session);return {status:'complete',createdSessionId:session.id};
  }}},async setActive({session,navigate}){calls.activate.push(session);await navigate({session:clerk.client.sessions.find(s=>s.id===session),decorateUrl:url=>url});}};
  const original=globalThis.fetch;
  globalThis.fetch=async(path,options)=>{
    calls.redeem++;assert.equal(path,'/api/auth/desktop/redeem');
    assert.deepEqual(JSON.parse(options.body),{id:attempt.id,verifier:attempt.verifier});
    return calls.redeem===1?Response.json({ticket:'private-ticket',userId:'user_approved'}):Response.json({error:'Approval already used'},{status:400});
  };
  t.after(()=>{globalThis.fetch=original;});
  return {calls,attempt,session,clerk,finish:navigate=>finishDesktopSignIn(attempt,clerk,navigate??(()=>{}))};
}

test('browser approval creates and activates exactly the returned desktop session',async t=>{
  const f=fixture(t);let activated;
  await f.finish(({session})=>{activated=session;});
  assert.equal(activated,f.session);assert.deepEqual(f.calls.activate,[f.session.id]);
  assert.equal(f.calls.redeem,1);assert.equal(f.calls.ticket,1);
});

test('activation failure retries the created session without replaying either single-use credential',async t=>{
  const f=fixture(t),activate=f.clerk.setActive;
  f.clerk.setActive=async()=>{throw Error('network failure containing private-ticket');};
  await assert.rejects(f.finish(),e=>e instanceof AuthRequestError&&/could not be activated/.test(e.message)&&!/private-ticket/.test(e.message));
  f.clerk.setActive=activate;await f.finish();
  assert.equal(f.calls.redeem,1);assert.equal(f.calls.ticket,1);assert.deepEqual(f.calls.activate,[f.session.id]);
});

test('lost ticket response recovers the approving user session on retry',async t=>{
  const f=fixture(t),create=f.clerk.client.signIn.create;
  f.clerk.client.signIn.create=async params=>{await create(params);throw Error('response lost');};
  await assert.rejects(f.finish(),/Complete sign-in again/);
  assert.equal(f.attempt.sessionId,undefined);
  await f.finish();
  assert.equal(f.calls.redeem,1);assert.equal(f.calls.ticket,1);assert.deepEqual(f.calls.activate,[f.session.id]);
});

test('a returning desktop activates an existing session only for the approved account',async t=>{
  const f=fixture(t);
  f.clerk.client.sessions=[{id:'sess_other',status:'active',user:{id:'user_other'}},f.session];
  await f.finish();assert.equal(f.calls.ticket,0);assert.deepEqual(f.calls.activate,[f.session.id]);
});

test('a different account is never activated or silently signed out',async t=>{
  const f=fixture(t);f.clerk.client.sessions=[{id:'sess_other',status:'active',user:{id:'user_other'}}];
  f.clerk.client.signIn.create=async()=>{throw {errors:[{code:'session_exists',message:'private-ticket'}]};};
  await assert.rejects(f.finish(),/Another account is signed in/);assert.deepEqual(f.calls.activate,[]);
});

test('a disconnected client retains the grant for retry before spending its ticket',async t=>{
  const f=fixture(t),reload=f.clerk.client.reload;
  f.clerk.client.reload=async()=>{throw Error('offline');};
  await assert.rejects(f.finish(),/Complete sign-in again/);
  f.clerk.client.reload=reload;await f.finish();
  assert.equal(f.calls.redeem,1);assert.equal(f.calls.ticket,1);
});

test('required session tasks reach the navigation callback without pretending the session is active',async t=>{
  const f=fixture(t);f.session.status='pending';f.session.currentTask={key:'choose-organization'};
  f.clerk.client.sessions=[f.session];let task;
  await f.finish(({session})=>{task=session.currentTask;});assert.deepEqual(task,f.session.currentTask);assert.equal(f.calls.ticket,0);
});

test('a created session missing from the client is reloaded before activation',async t=>{
  const f=fixture(t);
  f.clerk.client.signIn.create=async()=>({status:'complete',createdSessionId:f.session.id});
  f.clerk.client.reload=async()=>{if(++f.calls.reload===2)f.clerk.client.sessions=[f.session];};
  await f.finish();assert.equal(f.calls.reload,2);assert.deepEqual(f.calls.activate,[f.session.id]);
});

test('a revoked session cannot be activated or spend the ticket again',async t=>{
  const f=fixture(t);await f.finish();f.session.status='revoked';
  await assert.rejects(f.finish(),/session ended/);assert.equal(f.calls.ticket,1);assert.equal(f.calls.activate.length,1);
});

test('expired tickets have an actionable restart message without exposing provider errors',async t=>{
  const f=fixture(t);f.clerk.client.signIn.create=async()=>{throw {errors:[{code:'sign_in_token_expired',message:'private-ticket'}]};};
  await assert.rejects(f.finish(),e=>/Start again/.test(e.message)&&!/private-ticket/.test(e.message));assert.deepEqual(f.calls.activate,[]);
});

test('invalid approval responses cannot activate a session',async t=>{
  const f=fixture(t);globalThis.fetch=async()=>Response.json({ticket:'private-ticket'});
  await assert.rejects(f.finish(),e=>e.code==='invalid_response');assert.equal(f.calls.ticket,0);assert.deepEqual(f.calls.activate,[]);
});
