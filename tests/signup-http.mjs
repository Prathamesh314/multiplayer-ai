import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import nextEnv from '@next/env';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {issueSignupInvitation} from '../app/lib/auth/admission.ts';
nextEnv.loadEnvConfig(process.cwd());
const f=await memoryFixture({postgres:true});let child,exit;let output='';
try {
  const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',globalThis.__maPool.options.options);
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',String(port)],{
    env:{...process.env,DATABASE_URL:url.href,REDIS_URL:'',API_TRUST_PROXY:'0',SIGNUP_MODE:'invite',API_RATE_AUTH_BURST:'100',API_RATE_AUTH_PER_MINUTE:'100',MNEMOSYNE_URL:'',LOCAL_RUNNERS:'0'},stdio:['ignore','pipe','pipe']});
  exit=once(child,'exit');for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-10000);});
  const base='http://127.0.0.1:'+port;let ready=false;
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('Server startup failed: '+output);try{ready=(await fetch(base+'/login')).ok;}catch{}if(ready)break;await delay(100);}
  assert.ok(ready,'server starts');
  const page=await (await fetch(base+'/login')).text();assert.ok(page.includes('invitation link'));
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const input={handle:'invited',email:'invited@example.test',password:'fixture-long-password'};
  assert.equal((await post('/api/auth/continue',input)).status,403);
  assert.equal((await post('/api/auth/register',input)).status,403);
  const invitationToken=await issueSignupInvitation(input.email);
  assert.equal((await post('/api/auth/register',{...input,email:'wrong@example.test',invitationToken})).status,403);
  const eligible=await post('/api/auth/continue',{...input,invitationToken});assert.equal(eligible.status,200);assert.equal((await eligible.json()).status,'new');
  const registered=await post('/api/auth/register',{...input,invitationToken});assert.equal(registered.status,201);assert.match(registered.headers.get('set-cookie'),/ma_auth=/);
  assert.equal((await post('/api/auth/register',{...input,handle:'replay',invitationToken})).status,403);
  const loggedIn=await post('/api/auth/continue',input);assert.equal(loggedIn.status,200);assert.equal((await loggedIn.json()).status,'existing');
  console.log('PASS: production login page, direct API refusal, email binding, invitation signup, replay rejection and existing-user login.');
}finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await exit;}await f.close();}
