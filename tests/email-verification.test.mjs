import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import nextEnv from '@next/env';
import { memoryFixture } from './helpers/memory-fixture.mjs';
import { startEmailVerification, pendingEmailVerification, resendEmailVerification, verifyEmailCode, cancelEmailVerification } from '../app/lib/auth/email-verification.ts';
import { emailVerificationEnabled, emailDeliveryConfig, sendVerificationEmail } from '../app/lib/auth/email-delivery.ts';
import { policyFor } from '../app/lib/http/api-limit.ts';
if (process.env.EMAIL_TEST_POSTGRES === '1') nextEnv.loadEnvConfig(process.cwd());

const keys = ['EMAIL_VERIFICATION_ENABLED','RESEND_API_KEY','EMAIL_FROM'];
test('email verification is browser-bound, once-only, limited and atomic', async t => {
  const previous = Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{EMAIL_VERIFICATION_ENABLED:'true',RESEND_API_KEY:'test-resend-secret',EMAIL_FROM:'Multiplayer AI <verify@example.test>'});
  const nativeFetch = globalThis.fetch, sent = [];
  let deliveryFails = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(url,'https://api.resend.com/emails');
    assert.equal(options.headers.authorization,'Bearer test-resend-secret');
    assert.match(options.headers['Idempotency-Key'],/^email-verification\//);
    const body=JSON.parse(options.body), code=/code is (\d{6})/.exec(body.text)[1];
    sent.push({email:body.to[0],code});
    return deliveryFails ? Response.json({error:'secret-provider-response'},{status:503}) : Response.json({id:'test-message'});
  };
  const f = await memoryFixture({postgres:process.env.EMAIL_TEST_POSTGRES==='1'});
  const releaseCooldown = id => f.db.query("UPDATE email_verifications SET resend_after=now()-interval '1 second' WHERE user_id=$1",[id]);
  const lastCode = () => sent.at(-1).code;
  const wrong = code => code === '000000' ? '000001' : '000000';
  try {
    await t.test('configuration is explicit and provider errors never expose secrets', async()=>{
      assert.equal(emailVerificationEnabled(),true);
      delete process.env.RESEND_API_KEY;
      await assert.rejects(startEmailVerification(f.alice),error=>error.status===503);
      assert.equal(await f.first('SELECT * FROM email_verifications WHERE user_id=$1',[f.alice]),undefined);
      assert.throws(emailDeliveryConfig,error=>error.status===503);
      process.env.RESEND_API_KEY='test-resend-secret';
      deliveryFails=true;
      await assert.rejects(sendVerificationEmail('test@example.test','123456','fixture'),error=>!error.message.includes('secret-provider-response'));
      deliveryFails=false;
      for(const route of ['verify','resend','pending'])assert.equal(policyFor('/api/auth/email/'+route,'POST'),'auth');
    });
    await t.test('no plaintext code or browser secret is stored; another browser cannot verify',async()=>{
      const flow=await startEmailVerification(f.alice), code=lastCode();
      assert.equal(flow.verification.email,'alice@memory.test');
      assert.equal(flow.verification.deliveryStatus,'sent');
      assert.equal((await pendingEmailVerification(flow.token)).email,'alice@memory.test');
      const row=await f.first('SELECT * FROM email_verifications WHERE user_id=$1',[f.alice]);
      assert.deepEqual(Buffer.from(row.token_hash),createHash('sha256').update(flow.token).digest());
      assert.notDeepEqual(Buffer.from(row.code_hash),createHash('sha256').update(code).digest());
      assert.equal(Buffer.from(row.code_hash).length,32);
      await assert.rejects(verifyEmailCode(undefined,code),/expired/);
      await assert.rejects(verifyEmailCode('x'.repeat(43),code),/expired/);
      await assert.rejects(verifyEmailCode(flow.token,{code}),/six-digit/);
      for(let attempt=0;attempt<5;attempt++)await assert.rejects(verifyEmailCode(flow.token,wrong(code)),/incorrect/);
      assert.equal((await f.first('SELECT attempts FROM email_verifications WHERE user_id=$1',[f.alice])).attempts,5);
      await assert.rejects(verifyEmailCode(flow.token,code),error=>error.code==='attempts_exhausted');
      assert.equal((await pendingEmailVerification(flow.token)).attemptsRemaining,0,'reload preserves the exhausted-code state');
      const deliveries=sent.length;
      assert.equal((await startEmailVerification(f.alice,flow.token)).token,flow.token);
      assert.equal(sent.length,deliveries,'repeating login does not reset attempts or send another code');
      await assert.rejects(startEmailVerification(f.alice),error=>error.status===429);
      await assert.rejects(resendEmailVerification(flow.token),error=>error.status===429&&error.retryAfter>0);
      await releaseCooldown(f.alice);
      const resent=await resendEmailVerification(flow.token), newCode=lastCode();
      assert.equal(resent.deliveryStatus,'sent');assert.notEqual(newCode,code);
      await assert.rejects(verifyEmailCode(flow.token,code),/incorrect/);
      const race=await Promise.allSettled([verifyEmailCode(flow.token,newCode),verifyEmailCode(flow.token,newCode)]);
      assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(race.find(result=>result.status==='fulfilled').value.id,f.alice);
      assert.ok((await f.first('SELECT email_verified_at FROM users WHERE id=$1',[f.alice])).email_verified_at);
      assert.equal(await pendingEmailVerification(flow.token),null);
      await assert.rejects(verifyEmailCode(flow.token,newCode),/expired/);
      delete process.env.RESEND_API_KEY;
      assert.equal(await startEmailVerification(f.alice),null,'verified accounts need no code even during a mail configuration outage');
      process.env.RESEND_API_KEY='test-resend-secret';
    });
    await t.test('expiry, cancellation and new logins invalidate old challenges without resetting delivery limits',async()=>{
      const flow=await startEmailVerification(f.bob), code=lastCode();
      await f.db.query("UPDATE email_verifications SET code_expires_at=now()-interval '1 second' WHERE user_id=$1",[f.bob]);
      await assert.rejects(verifyEmailCode(flow.token,code),/expired/);
      await cancelEmailVerification(flow.token);
      assert.equal(await pendingEmailVerification(flow.token),null);
      await assert.rejects(resendEmailVerification(flow.token),/expired/);
      await assert.rejects(startEmailVerification(f.bob),error=>error.status===429);
      await releaseCooldown(f.bob);
      const replacement=await startEmailVerification(f.bob);
      assert.notEqual(replacement.token,flow.token);
      await assert.rejects(verifyEmailCode(flow.token,lastCode()),/expired/);
      await releaseCooldown(f.bob);
      const race=await Promise.allSettled([resendEmailVerification(replacement.token),resendEmailVerification(replacement.token)]);
      assert.equal(race.filter(result=>result.status==='fulfilled').length,1);
      for(let count=0;count<2;count++){await releaseCooldown(f.bob);await resendEmailVerification(replacement.token);}
      await releaseCooldown(f.bob);
      await assert.rejects(resendEmailVerification(replacement.token),error=>error.status===429&&error.retryAfter>3000);
      await f.db.query("UPDATE email_verifications SET window_started_at=now()-interval '2 hours' WHERE user_id=$1",[f.bob]);
      await resendEmailVerification(replacement.token);
      assert.equal((await f.first('SELECT send_count FROM email_verifications WHERE user_id=$1',[f.bob])).send_count,1);
    });
    await t.test('delivery failure grants no verification and can recover through resend',async()=>{
      deliveryFails=true;
      const flow=await startEmailVerification(f.outsider);
      assert.equal(flow.verification.deliveryStatus,'failed');
      await assert.rejects(verifyEmailCode(flow.token,lastCode()),/hasn’t been sent/);
      assert.equal((await f.first('SELECT email_verified_at FROM users WHERE id=$1',[f.outsider])).email_verified_at,null);
      deliveryFails=false;await releaseCooldown(f.outsider);
      await resendEmailVerification(flow.token);
      await f.db.query('UPDATE users SET email=$2 WHERE id=$1',[f.outsider,'changed@example.test']);
      await assert.rejects(verifyEmailCode(flow.token,lastCode()),/expired/);
      await assert.rejects(resendEmailVerification(flow.token),/expired/);
      assert.equal(await pendingEmailVerification(flow.token),null);
    });
    await t.test('deleted users and expired browser requests cannot complete verification',async()=>{
      await releaseCooldown(f.bob);
      const flow=await startEmailVerification(f.bob);
      await f.db.query("UPDATE email_verifications SET token_expires_at=now()-interval '1 second' WHERE user_id=$1",[f.bob]);
      await assert.rejects(verifyEmailCode(flow.token,lastCode()),/expired/);
      await f.db.query("UPDATE users SET deleted_at=now() WHERE id=$1",[f.bob]);
      await assert.rejects(startEmailVerification(f.bob),/expired/);
    });
    await t.test('disabling rollout does not falsely mark existing email addresses as verified',async()=>{
      process.env.EMAIL_VERIFICATION_ENABLED='false';
      assert.equal(await startEmailVerification(f.outsider),null);
      assert.equal((await f.first('SELECT email_verified_at FROM users WHERE id=$1',[f.outsider])).email_verified_at,null);
    });
  } finally {
    globalThis.fetch=nativeFetch;
    for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await f.close();
  }
});
