import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import nextEnv from '@next/env';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {emailBrowserCheck} from './helpers/email-browser.mjs';
nextEnv.loadEnvConfig(process.cwd());
const f=await memoryFixture({postgres:true}), servers=[];
const directory=await mkdtemp(join(tmpdir(),'email-verification-http-')),outbox=join(directory,'outbox.jsonl');
let logs='';
const freePort=async()=>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;};
const authCookie=response=>response.headers.getSetCookie().find(value=>value.startsWith('ma_auth='))?.split(';')[0];
const pendingCookie=response=>response.headers.getSetCookie().find(value=>value.startsWith('__Host-ma_email='))?.split(';')[0];
const messages=async()=>((await readFile(outbox,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
const codeFor=async email=>(await messages()).filter(message=>message.email===email).at(-1)?.code;
try {
  await writeFile(outbox,'',{mode:0o600});
  const ports=[await freePort(),await freePort()],base=`http://127.0.0.1:${ports[0]}`,second=`http://127.0.0.1:${ports[1]}`;
  const database=new URL(process.env.DATABASE_URL);database.searchParams.set('options',globalThis.__maPool.options.options);
  for(const port of ports){
    const child=spawn(process.execPath,['--import','./tests/helpers/email-provider-fixture.mjs','node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',String(port)],{
      env:{...process.env,DATABASE_URL:database.href,REDIS_URL:'',MNEMOSYNE_URL:'',LOCAL_RUNNERS:'0',WEB_CONCURRENCY:'1',API_TRUST_PROXY:'0',SIGNUP_MODE:'open',AUTH_PUBLIC_URL:base,
        GOOGLE_CLIENT_ID:'',GOOGLE_CLIENT_SECRET:'',GOOGLE_OAUTH_CREDENTIALS_FILE:'',EMAIL_VERIFICATION_ENABLED:'true',RESEND_API_KEY:'fixture-resend-key',EMAIL_FROM:'Multicode AI <verify@example.test>',EMAIL_PROVIDER_TEST:'1',EMAIL_TEST_OUTBOX:outbox,API_RATE_AUTH_BURST:'200',API_RATE_AUTH_PER_MINUTE:'200'},stdio:['ignore','pipe','pipe']});
    servers.push({child,exit:once(child,'exit')});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{logs=(logs+chunk).slice(-8000);});
    let ready=false;for(let count=0;count<150;count++){if(child.exitCode!==null)throw Error(logs);try{ready=(await fetch(`http://127.0.0.1:${port}/login`)).ok;}catch{}if(ready)break;await delay(100);}assert.ok(ready);
  }
  const request=(path,body,jar='',server=base,origin=base,method='POST')=>fetch(server+path,{method,redirect:'manual',headers:{'content-type':'application/json',cookie:jar,...(origin?{origin}:{})},body:method==='DELETE'?undefined:JSON.stringify(body)});
  const email='verify-http@example.test',password='fixture-long-password';
  const created=await request('/api/auth/register',{email,password,email_verified_at:new Date().toISOString()});
  assert.equal(created.status,202,await created.clone().text());
  const payload=await created.json();assert.equal(payload.status,'verification_required');assert.equal(payload.user,undefined);
  assert.equal(authCookie(created),undefined);assert.match(created.headers.get('set-cookie'),/HttpOnly/);assert.match(created.headers.get('set-cookie'),/Secure/);
  const jar=pendingCookie(created),code=await codeFor(email);assert.ok(jar);assert.match(code,/^\d{6}$/);
  const me=await(await fetch(base+'/api/auth/me',{headers:{cookie:jar}})).json();assert.equal(me.user,null);
  const pendingPage=await(await fetch(base+'/login',{headers:{cookie:jar}})).text();assert.ok(pendingPage.includes('Verify your email'));assert.ok(pendingPage.includes('one-time-code'));assert.ok(!pendingPage.includes('fixture-resend-key'));
  const expired=await request('/api/auth/email/verify',{code},'',second);
  assert.equal(expired.status,409);assert.equal((await expired.json()).code,'verification_expired');
  assert.equal((await request('/api/auth/email/verify',{code},jar,second,'https://attacker.example')).status,403);
  assert.equal((await request('/api/auth/email/verify',{code},jar,second,'')).status,403);
  const wrong=await request('/api/auth/email/verify',{code:code==='000000'?'000001':'000000'},jar,second);
  assert.equal(wrong.status,400);assert.equal(authCookie(wrong),undefined);assert.equal((await wrong.json()).code,'incorrect_code');
  const cooldown=await request('/api/auth/email/resend',{},jar,second);assert.equal(cooldown.status,429);assert.ok(Number(cooldown.headers.get('retry-after'))>0);assert.equal((await cooldown.json()).code,'resend_limited');
  assert.equal((await request('/api/auth/login',{identifier:email,password:'incorrect'},jar,second)).status,401);
  const unverifiedLogin=await request('/api/auth/login',{identifier:email,password},jar,second);assert.equal(unverifiedLogin.status,202);assert.equal(authCookie(unverifiedLogin),undefined);
  const legacy=await request('/api/auth/continue',{email,password},jar,second);assert.equal(legacy.status,202);assert.equal(authCookie(legacy),undefined);
  assert.equal((await messages()).filter(message=>message.email===email).length,1,'legacy endpoint cannot bypass verification or resend limits');
  const verified=await request('/api/auth/email/verify',{code},jar,second);assert.equal(verified.status,200,await verified.clone().text());assert.ok(authCookie(verified));assert.equal((await verified.json()).user.email,email);
  assert.equal((await request('/api/auth/email/verify',{code},jar)).status,409,'single-use code');
  const returning=await request('/api/auth/login',{identifier:email,password});assert.equal(returning.status,200);assert.ok(authCookie(returning));assert.equal((await messages()).filter(message=>message.email===email).length,1,'verified users receive no more codes');
  console.log('PASS: signup/legacy login issue no session before email verification; refresh, CSRF, replay, replica sharing and once-only login work.');

  const failed=await request('/api/auth/register',{email:'delivery-fails@example.test',password});
  assert.equal(failed.status,202);const failedState=await failed.json();assert.equal(failedState.verification.deliveryStatus,'failed');assert.equal(authCookie(failed),undefined);assert.ok(!JSON.stringify(failedState).includes('secret-provider-error'));
  assert.equal((await request('/api/auth/email/verify',{code:await codeFor('delivery-fails@example.test')},pendingCookie(failed))).status,400);
  const cancellation=await request('/api/auth/email/pending',undefined,pendingCookie(failed),base,base,'DELETE');assert.equal(cancellation.status,200);
  assert.equal((await request('/api/auth/email/verify',{code:await codeFor('delivery-fails@example.test')},pendingCookie(failed))).status,409);
  console.log('PASS: delivery failures keep the account unverified and allow recovery without leaking provider errors.');

  await emailBrowserCheck({base,codeFor,releaseCooldown:async email=>{
    await f.db.query("UPDATE email_verifications SET resend_after=now()-interval '1 second' WHERE user_id=(SELECT id FROM users WHERE email=$1)",[email]);
  },expireRequest:async email=>{
    await f.db.query("UPDATE email_verifications SET token_expires_at=now()-interval '1 second' WHERE user_id=(SELECT id FROM users WHERE email=$1)",[email]);
  }});
} finally {
  for(const {child}of servers)if(child.exitCode===null)child.kill('SIGTERM');
  await Promise.all(servers.map(({exit})=>exit));await f.close();await rm(directory,{recursive:true,force:true});
}
