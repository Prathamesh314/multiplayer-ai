import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomBytes} from 'node:crypto';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {completeClerkAccount,verifiedClerkProfile,syncClerkProfile,deleteClerkAccount,userForClerkSession,recordClerkRevocation,hasOnboarded,markOnboarded} from '../app/lib/auth/clerk-store.ts';
import {createDesktopSignIn,approveDesktopSignIn,consumeDesktopSignIn} from '../app/lib/auth/clerk-desktop.ts';
import {issueSignupInvitation} from '../app/lib/auth/admission.ts';
const profile=(id,email,extra={})=>({id,primary_email_address_id:'primary',email_addresses:[{id:'primary',email_address:email,verification:{status:'verified'}}],first_name:'Test',last_name:'User',updated_at:100,...extra});
test('Clerk owns identity while local UUIDs, permissions and admission survive the migration',async()=>{
 const f=await memoryFixture({postgres:process.env.CLERK_TEST_POSTGRES==='1'});const before=process.env.SIGNUP_MODE;process.env.SIGNUP_MODE='open';
 try{
  assert.throws(()=>verifiedClerkProfile(profile('bad','alice@memory.test',{email_addresses:[{id:'primary',email_address:'alice@memory.test',verification:{status:'unverified'}}]})),/Verify/);
  assert.throws(()=>verifiedClerkProfile(profile('bad','alice@memory.test',{banned:true})),/unavailable/);
  const [alice,concurrent]=await Promise.all([completeClerkAccount(profile('user_alice','ALICE@memory.test')),completeClerkAccount(profile('user_alice','alice@memory.test'))]);
  assert.equal(alice.id,concurrent.id);
  assert.equal(alice.id,f.alice);assert.equal((await f.first('SELECT count(*)::int AS n FROM project_members WHERE user_id=$1',[alice.id])).n,1);
  assert.equal((await completeClerkAccount(profile('user_alice','alice@memory.test'))).id,f.alice);
  await assert.rejects(completeClerkAccount(profile('user_imposter','alice@memory.test')),/another workspace account/);
  await assert.rejects(completeClerkAccount(profile('user_alice','bob@memory.test')),/another workspace account/);
  await syncClerkProfile(profile('user_alice','alice@memory.test',{updated_at:200,first_name:'New'}));
  await completeClerkAccount(profile('user_alice','alice@memory.test',{updated_at:150,first_name:'Old'}));
  assert.equal((await userForClerkSession('user_alice','session_live')).displayName,'New User');
  await recordClerkRevocation('session_revoked');await recordClerkRevocation('session_revoked');
  assert.equal(await userForClerkSession('user_alice','session_revoked'),null);
  await syncClerkProfile(profile('user_alice','alice@memory.test',{updated_at:300,locked:true}));
  assert.equal(await userForClerkSession('user_alice','session_live'),null);
  await syncClerkProfile(profile('user_alice','alice@memory.test',{updated_at:301}));
  assert.ok(await userForClerkSession('user_alice','session_live'));
  process.env.SIGNUP_MODE='invite';
  await assert.rejects(completeClerkAccount(profile('new_user','new@example.test')),/invit/i);
  const invitation=await issueSignupInvitation('new@example.test');
  const token=invitation;
  const created=await completeClerkAccount(profile('new_user','new@example.test'),token);
  assert.ok(created.id);assert.equal((await completeClerkAccount(profile('new_user','new@example.test'))).id,created.id);
  await syncClerkProfile(profile('unadmitted','unadmitted@example.test'));
  assert.equal(await userForClerkSession('unadmitted','session_live'),null,'webhooks cannot provision accounts');
  await f.db.query("INSERT INTO runner_devices(user_id,name,token_hash) VALUES($1,'Computer',$2)",[f.alice,Buffer.alloc(32)]);
  await deleteClerkAccount('never_provisioned');
  await assert.rejects(completeClerkAccount(profile('never_provisioned','late@example.test')),/deleted/);
  await deleteClerkAccount('user_alice');await deleteClerkAccount('user_alice');
  await syncClerkProfile(profile('user_alice','alice@memory.test',{updated_at:400}));
  assert.equal(await userForClerkSession('user_alice','session_live'),null);
  await assert.rejects(completeClerkAccount(profile('user_alice','alice@memory.test')),/deleted/);
  assert.ok((await f.first('SELECT revoked_at FROM runner_devices WHERE user_id=$1',[f.alice])).revoked_at);
 }finally{if(before===undefined)delete process.env.SIGNUP_MODE;else process.env.SIGNUP_MODE=before;await f.close();}
});
test('the first-run setup step is offered once and never returns on later sign-ins',async()=>{
 const f=await memoryFixture();const before=process.env.SIGNUP_MODE;process.env.SIGNUP_MODE='open';
 try{
  const user=await completeClerkAccount(profile('user_alice','alice@memory.test'));
  assert.equal(await hasOnboarded(user.id),false,'a new account must be offered the setup step');
  await markOnboarded(user.id);
  assert.equal(await hasOnboarded(user.id),true);
  const stamp=(await f.first('SELECT onboarded_at FROM users WHERE id=$1',[user.id])).onboarded_at;
  await markOnboarded(user.id);
  assert.deepEqual((await f.first('SELECT onboarded_at FROM users WHERE id=$1',[user.id])).onboarded_at,stamp,'marking again must not move the timestamp');
  // The desktop provisions its account in a browser tab, then signs in again in the app.
  assert.equal(await hasOnboarded((await completeClerkAccount(profile('user_alice','alice@memory.test'))).id),true,'a later sign-in must not replay the step');
 }finally{if(before===undefined)delete process.env.SIGNUP_MODE;else process.env.SIGNUP_MODE=before;await f.close();}
});
test('desktop approval requires matching proof, explicit approval, one use and an unexpired request',async()=>{
 const f=await memoryFixture();try{
 const verifier=randomBytes(32).toString('base64url'),challenge=createHash('sha256').update(verifier).digest('base64url');
 const request=await createDesktopSignIn(challenge);
 await assert.rejects(consumeDesktopSignIn(request.id,verifier),/approve/);
 await approveDesktopSignIn(request.id,'user_alice','session_live');
 await assert.rejects(approveDesktopSignIn(request.id,'user_bob','session_other'),/expired/);
 await assert.rejects(consumeDesktopSignIn(request.id,randomBytes(32).toString('base64url')),/approve/);
 assert.equal((await consumeDesktopSignIn(request.id,verifier)).clerk_user_id,'user_alice');
 await assert.rejects(consumeDesktopSignIn(request.id,verifier),/approve/);
 const expired=await createDesktopSignIn(challenge);
 await f.db.query("UPDATE clerk_desktop_signins SET expires_at=now()-interval '1 minute' WHERE id=$1",[expired.id]);
 await assert.rejects(approveDesktopSignIn(expired.id,'user_alice','session_live'),/expired/);
 }finally{await f.close();}
});
