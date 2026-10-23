import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import nextEnv from '@next/env';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {clerkFixture,clerkCookie} from './helpers/clerk-fixture.mjs';
import {issueSignupInvitation} from '../app/lib/auth/admission.ts';
nextEnv.loadEnvConfig(process.cwd());
const f=await memoryFixture({postgres:true}),clerk=await clerkFixture();
const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const base=`http://127.0.0.1:${port}`,url=new URL(process.env.DATABASE_URL);url.searchParams.set('options',globalThis.__maPool.options.options);
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p',String(port)],{env:{...process.env,...clerk.env,DATABASE_URL:url.href,REDIS_URL:'',AUTH_PUBLIC_URL:base,SIGNUP_MODE:process.argv.includes('--invite')?'invite':'open',API_TRUST_PROXY:'0',API_RATE_AUTH_BURST:'200',API_RATE_AUTH_PER_MINUTE:'200',API_RATE_ANONYMOUS_BURST:'200',MNEMOSYNE_URL:'',LOCAL_RUNNERS:'0'},stdio:['ignore','pipe','pipe']});
let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-12000);});
const api=(path,token,body,headers={},method=body===undefined?'GET':'POST')=>fetch(base+path,{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',origin:base,...(token?{authorization:`Bearer ${token}`} : {}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
try{
 let ready=false;for(let i=0;i<200;i++){if(child.exitCode!==null)throw Error(output);try{ready=(await fetch(base+'/health/ready',{signal:AbortSignal.timeout(3000)})).ok;}catch{}if(ready)break;await delay(100);}assert.ok(ready,output);
 console.log('Test server ready; checking retired login endpoints.');
 for(const path of ['/api/auth/login','/api/auth/register','/api/auth/continue','/api/auth/email/verify','/api/auth/google/complete'])assert.equal((await api(path,null,{})).status,410,path);
 assert.equal((await api('/api/orgs')).status,401);
 const legacy=randomBytes(32).toString('base64url');await f.db.query("INSERT INTO auth_tokens(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')",[f.alice,createHash('sha256').update(legacy).digest()]);
 assert.equal((await api('/api/orgs',null,undefined,{cookie:`ma_auth=${legacy}`})).status,401,'legacy cookie cannot authenticate');
 const alice=await clerk.link(f.db,f.alice,{origin:base,sessionId:'sess_alice'});
 const me=await api('/api/auth/me',alice);assert.equal(me.status,200,await me.clone().text());assert.equal((await me.json()).user.id,f.alice);
 // A member renames their @username; another site cannot, and a taken one is refused.
 const rename=(token,handle,headers={})=>api('/api/auth/me',token,{handle},headers,'PATCH');
 const renamed=await rename(alice,'@Alice_Dev');assert.equal(renamed.status,200,await renamed.clone().text());assert.equal((await renamed.json()).user.handle,'alice_dev');
 assert.equal((await rename(alice,'bob')).status,409,'usernames are unique');
 assert.equal((await rename(alice,'no spaces')).status,400);
 assert.equal((await rename(null,'nobody')).status,401);
 assert.equal((await rename(alice,'stolen',{origin:'https://evil.example'})).status,403,'other sites cannot rename you');
 assert.equal((await(await api('/api/auth/me',alice)).json()).user.handle,'alice_dev');
 assert.equal((await api('/api/orgs',alice)).status,200);
 assert.equal((await api('/api/orgs',null,undefined,{cookie:clerkCookie(alice)})).status,200,'browser cookies authenticate through the same Clerk verifier');
 assert.equal((await api('/api/orgs',null,undefined,{'x-clerk-auth-status':'signed-in','x-clerk-auth-token':alice})).status,401,'forged middleware headers cannot authenticate');
 const invalid=await clerk.token('user_'+f.alice,{origin:'https://evil.example'});
 assert.equal((await api('/api/orgs',invalid)).status,401,'wrong authorized party rejected');
 const expired=await clerk.token('user_'+f.alice,{origin:base,expiresIn:-100});
 assert.equal((await api('/api/orgs',expired)).status,401,'expired JWT rejected');
 const token=await clerk.token('user_bob',{origin:base});clerk.profile('user_bob','bob@memory.test');
 assert.equal((await api('/api/orgs',token)).status,401,'Clerk sign-in alone cannot skip workspace admission');
 assert.equal((await api('/api/auth/complete',token,{}, {origin:'https://evil.example'})).status,403);
 const linked=await api('/api/auth/complete',token,{email:'attacker@example.test'});assert.equal(linked.status,200,await linked.clone().text());assert.equal((await linked.json()).user.id,f.bob,'verified provider email wins over request body');
 // A second Clerk identity for Bob's email is refused while his original one exists...
 clerk.profile('user_bob_live','bob@memory.test');const bobLive=await clerk.token('user_bob_live',{origin:base});
 const refused=await api('/api/auth/complete',bobLive,{});assert.equal(refused.status,403);assert.match((await refused.json()).error,/Sign in the way you did before/);
 // ...and relinks his same account once that identity no longer holds the address (changed, deleted, or another Clerk instance).
 clerk.profile('user_bob','bob-old-address@memory.test');
 const relinked=await api('/api/auth/complete',bobLive,{});assert.equal(relinked.status,200,await relinked.clone().text());assert.equal((await relinked.json()).user.id,f.bob,'a stale Clerk link is relinked to the same account');
 clerk.profile('user_unverified','unverified@example.test',{email_addresses:[{id:'email_user_unverified',email_address:'unverified@example.test',verification:{status:'unverified'},linked_to:[]}]});
 assert.equal((await api('/api/auth/complete',await clerk.token('user_unverified',{origin:base}),{})).status,403);
 clerk.profile('user_new','new@example.test');
 const newcomer=await clerk.token('user_new',{origin:base});
 let invitationToken;
 if(process.argv.includes('--invite')){
   assert.equal((await api('/api/auth/complete',newcomer,{})).status,403,'Clerk identity does not bypass invitation admission');
   const wrong=await issueSignupInvitation('different@example.test');
   assert.equal((await api('/api/auth/complete',newcomer,{invitationToken:wrong})).status,403,'invitation email must match the verified Clerk email');
   invitationToken=await issueSignupInvitation('new@example.test');
 }
 const admitted=await api('/api/auth/complete',newcomer,{invitationToken});
 assert.equal(admitted.status,200,await admitted.clone().text());
 const admittedId=(await admitted.json()).user.id;
 assert.equal((await (await api('/api/auth/complete',newcomer,{})).json()).user.id,admittedId,'repeat completion preserves the account and needs no second invitation');
 assert.equal((await api('/api/auth/complete',newcomer,{padding:'x'.repeat(20*1024)})).status,400,'oversized auth bodies are bounded');
 const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
 const desktop=await(await api('/api/auth/desktop',null,{challenge})).json();assert.ok(desktop.id);
 assert.equal((await api('/api/auth/desktop/approve',null,{id:desktop.id})).status,401);
 assert.equal((await api('/api/auth/desktop/approve',alice,{id:desktop.id})).status,200);
 assert.equal((await api('/api/auth/desktop/redeem',null,{id:desktop.id,verifier:'x'.repeat(43)})).status,400);
 const redeemed=await api('/api/auth/desktop/redeem',null,{id:desktop.id,verifier});
 assert.equal(redeemed.status,200);
 assert.deepEqual(await redeemed.json(),{ticket:'one-use-fixture-ticket',userId:'user_'+f.alice},'the ticket is bound to the approving account for desktop session recovery');
 assert.equal((await api('/api/auth/desktop/redeem',null,{id:desktop.id,verifier})).status,400);
 // One account, several devices at once: each device has its own Clerk session.
 const laptop=await clerk.token('user_'+f.alice,{origin:base,sessionId:'sess_alice_laptop'}),phone=await clerk.token('user_'+f.alice,{origin:base,sessionId:'sess_alice_phone'});
 const who=async token=>(await(await api('/api/auth/me',token)).json()).user?.id??null;
 assert.deepEqual(await Promise.all([who(alice),who(laptop),who(phone)]),[f.alice,f.alice,f.alice],'the same account works on every device at once');
 assert.equal((await api('/api/auth/complete',phone,{})).status,200,'finishing sign-in on a phone works while other devices are signed in');
 assert.equal((await api('/api/orgs',laptop)).status,200,'and does not sign the other devices out');
 assert.equal((await api('/api/auth/me',phone,undefined,{},'DELETE')).status,200);
 assert.equal(await who(phone),null,'signing out on the phone ends only the phone session');
 assert.equal(clerk.sessions.get('sess_alice_phone').status,'revoked','and revokes it at Clerk');
 assert.equal(await who(laptop),f.alice,'the laptop stays signed in');
 assert.equal(await who(alice),f.alice);
 // Another person's token can never use this account's session.
 assert.equal(await who(await clerk.token('user_'+f.alice,{origin:'https://evil.example',sessionId:'sess_alice_laptop'})),null,'a token minted for another site is refused');
 const event={type:'session.revoked',data:{object:'session',id:'sess_alice',user_id:'user_'+f.alice}},raw=JSON.stringify(event),id='msg_fixture',timestamp=String(Math.floor(Date.now()/1000));
 const signature=createHmac('sha256',Buffer.from(clerk.env.CLERK_WEBHOOK_SIGNING_SECRET.slice(6),'base64')).update(`${id}.${timestamp}.${raw}`).digest('base64');
 assert.equal((await api('/api/webhooks/clerk',null,event)).status,400);
 assert.equal((await api('/api/webhooks/clerk',null,event,{'svix-id':id,'svix-timestamp':timestamp,'svix-signature':`v1,${signature}`})).status,200);
 assert.equal((await api('/api/orgs',alice)).status,401,'signed revocation takes effect immediately');
 console.log('PASS: Clerk JWT verification, account linking, verified emails, origin checks, retired credentials, signed webhooks, revocation, desktop proof and replay protection.');
}catch(error){console.error(output);throw error;}finally{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}await clerk.close();await f.close();}
