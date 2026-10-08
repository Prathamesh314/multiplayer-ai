import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {clerkFixture,clerkCookie} from './helpers/clerk-fixture.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import nextEnv from '@next/env';
import {memoryFixture} from './helpers/memory-fixture.mjs';

nextEnv.loadEnvConfig(process.cwd());
const publicUrl='https://workspace.example.test';
const fixture=await memoryFixture({postgres:true}),clerk=await clerkFixture({origin:publicUrl});
let child,exit,base;let output='';
const api=(path,body,cookie='',headers={})=>fetch(base+path,{
  method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',origin:publicUrl,cookie,...headers},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
});
async function stop(){if(child&&child.exitCode===null){child.kill('SIGTERM');await exit;}}
async function start(origin){
  await stop();
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
  const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  base=`http://127.0.0.1:${port}`;
  const database=new URL(process.env.DATABASE_URL);database.searchParams.set('options',globalThis.__maPool.options.options);
  // Match production's bind address: Next's request URL is not the public URL.
  child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','0.0.0.0','-p',String(port)],{
    env:{...process.env,...clerk.env,DATABASE_URL:database.href,REDIS_URL:'',MNEMOSYNE_URL:'',LOCAL_RUNNERS:'0',WEB_CONCURRENCY:'1',API_TRUST_PROXY:'0',
      AUTH_PUBLIC_URL:origin,SIGNUP_MODE:'invite',EMAIL_VERIFICATION_ENABLED:'false'},stdio:['ignore','pipe','pipe'],
  });
  exit=once(child,'exit');for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-12000);});
  for(let i=0;i<150;i++){
    if(child.exitCode!==null)throw Error('Test server failed: '+output);
    try{if((await fetch(base+'/login')).ok)return;}catch{}
    await delay(100);
  }
  throw Error('Test server did not start: '+output);
}
try {
  const cookies=[];
  for(const userId of [fixture.alice,fixture.bob]){
    cookies.push(clerkCookie(await clerk.link(fixture.db,userId)));
  }
  const [owner,member]=cookies,endpoint='/api/orgs/memory/invitations';
  await start(publicUrl);
  const body={via:'email',email:'friend@example.test',role:'member'};
  assert.equal((await api(endpoint,body)).status,401);
  assert.equal((await api(endpoint,body,member)).status,403);
  const created=await api(endpoint,body,owner,{host:'0.0.0.0:3000','x-forwarded-host':'attacker.example','x-forwarded-proto':'https'});
  assert.equal(created.status,201,await created.clone().text());
  const invitation=await created.json(),link=new URL(invitation.link);
  assert.equal(link.origin,publicUrl);
  assert.match(link.pathname,/^\/invite\/[A-Za-z0-9_-]{43}$/);
  assert.ok(invitation.expiresAt>Date.now());
  assert.equal(created.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+link.pathname)).status,200,'the generated invitation path is served');
  const token=link.pathname.split('/').at(-1);
  clerk.profile('user_friend',body.email);
  const friend=clerkCookie(await clerk.token('user_friend'));
  const registered=await api('/api/auth/complete',{invitationToken:token},friend);
  assert.equal(registered.status,200,await registered.clone().text());
  assert.equal((await api('/api/invitations/accept',{token},friend)).status,200);
  const joined=await(await api('/api/orgs',undefined,friend)).json();
  assert.ok(joined.orgs.some(org=>org.slug==='memory'),'a new account joins the intended organisation');
  assert.equal((await api('/api/invitations/accept',{token},friend)).status,409,'invitation stays one-time');
  console.log('PASS: public invitation URL behind an internal bind address, spoofed-host refusal, new-user signup, joining and one-time acceptance.');

  const pendingEmail='pending@example.test';
  const pending=await(await api(endpoint,{...body,email:pendingEmail},owner)).json();
  const before=await fixture.db.query(`SELECT id,token_hash,revoked_at FROM org_invitations WHERE email=$1 ORDER BY created_at`,[pendingEmail]);
  for(const invalidOrigin of ['', 'https://0.0.0.0:3000']){
    await start(invalidOrigin);
    const failed=await api(endpoint,{...body,email:pendingEmail},owner);
    assert.equal(failed.status,invalidOrigin ? 401 : 503);
    if(!invalidOrigin)assert.match((await failed.json()).error,/public website address/);
    const after=await fixture.db.query(`SELECT id,token_hash,revoked_at FROM org_invitations WHERE email=$1 ORDER BY created_at`,[pendingEmail]);
    assert.deepEqual(after.rows,before.rows,'bad configuration neither creates an invitation nor revokes the previous one');
  }
  await start(publicUrl);
  const pendingToken=new URL(pending.link).pathname.split('/').at(-1);
  assert.equal((await api('/api/invitations/accept',{token:pendingToken},friend)).status,200,'existing invitation remains usable without regenerating it');
  console.log('PASS: missing/invalid public origin shows a clear error and preserves existing invitation links.');
} finally {await stop();await clerk.close();await fixture.close();}
