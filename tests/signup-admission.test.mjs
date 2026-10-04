import assert from 'node:assert/strict';
import {test} from 'node:test';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {createUser,authenticate} from '../app/lib/repo/users.ts';
import {issueSignupInvitation,signupInvitation} from '../app/lib/auth/admission.ts';
import {inviteByEmail,acceptInvitationByToken} from '../app/lib/org/store.ts';
import nextEnv from '@next/env';
if(process.env.ADMISSION_TEST_POSTGRES==='1')nextEnv.loadEnvConfig(process.cwd());

test('registration admission preserves login and atomically claims private invitations',async t=>{
  const f=await memoryFixture({postgres:process.env.ADMISSION_TEST_POSTGRES==='1'});
  const input=(handle,email,invitationToken)=>({handle,email,password:'test-admission-password',displayName:handle,invitationToken});
  process.env.SIGNUP_MODE='invite';
  try {
    await t.test('direct registration without a token and a mismatched email fail',async()=>{
      assert.equal((await createUser(input('newuser','new@example.test'))).field,'invitation');
      const token=await issueSignupInvitation('new@example.test');
      assert.equal((await createUser(input('newuser','wrong@example.test',token))).field,'invitation');
      await assert.rejects(signupInvitation('new@example.test','bad'));
      await assert.rejects(signupInvitation('new@example.test',undefined),/Paste your invitation/);
      await assert.rejects(signupInvitation('new@example.test','bad'),/incomplete/);
      await assert.rejects(signupInvitation('wrong@example.test',token),/does not match this email/);
    });
    await t.test('one winner under concurrent claims and no replay',async()=>{
      const token=await issueSignupInvitation('race@example.test');
      const results=await Promise.all(['raceone','racetwo'].map(h=>createUser(input(h,'race@example.test',token))));
      assert.equal(results.filter(r=>r.ok).length,1);
      assert.equal((await createUser(input('racethree','race@example.test',token))).ok,false);
      const stored=await f.first('SELECT used_by,used_at,token_hash FROM signup_invitations WHERE email=$1',['race@example.test']);
      assert.ok(stored.used_by);assert.ok(stored.used_at);assert.notEqual(Buffer.from(stored.token_hash).toString(),token);
    });
    await t.test('failed username insert rolls back token consumption',async()=>{
      const token=await issueSignupInvitation('retry@example.test');
      assert.equal((await createUser(input('alice','retry@example.test',token))).field,'handle');
      assert.equal((await createUser(input('retryname','retry@example.test',token))).ok,true);
    });
    await t.test('expired or revoked tokens fail; closed mode blocks even valid tokens',async()=>{
      for(const field of ['expires_at','revoked_at']) {
        const email=field+'@example.test',token=await issueSignupInvitation(email);
        await f.db.query(`UPDATE signup_invitations SET ${field}=now()-interval '1 second' WHERE email=$1`,[email]);
        assert.equal((await createUser(input('expireduser',email,token))).field,'invitation');
      }
      const token=await issueSignupInvitation('closed@example.test');process.env.SIGNUP_MODE='closed';
      assert.equal((await createUser(input('closeduser','closed@example.test',token))).field,'invitation');
      assert.ok(await authenticate('retry@example.test','test-admission-password'));
      process.env.SIGNUP_MODE='invite';
    });
    await t.test('organisation invitations admit one matching account and preserve the join flow',async()=>{
      const invitation=await inviteByEmail(f.org,'teammate@example.test','member',f.alice);
      assert.equal(invitation.ok,true);
      const account=await createUser(input('teammate','teammate@example.test',invitation.token));assert.equal(account.ok,true);
      assert.equal((await createUser(input('teammatetwo','another@example.test',invitation.token))).ok,false);
      assert.equal((await acceptInvitationByToken(invitation.token,account.user.id)).ok,true);
      assert.equal((await f.first('SELECT status FROM org_members WHERE org_id=$1 AND user_id=$2',[f.org,account.user.id])).status,'active');
    });
    await t.test('open signup creates accounts without choosing a username',async()=>{
      process.env.SIGNUP_MODE='open';
      const accounts=await Promise.all(['first','second'].map(id=>createUser({email:id+'@example.test',password:'test-admission-password',displayName:'同じ名前'})));
      for(const account of accounts){assert.equal(account.ok,true);assert.match(account.user.handle,/^[a-z0-9][a-z0-9_-]{1,38}$/);}
      assert.notEqual(accounts[0].user.handle,accounts[1].user.handle);
      const minimal=await createUser({email:'minimal@example.test',password:'test-admission-password',displayName:''});
      assert.equal(minimal.ok,true);assert.equal(minimal.user.displayName,'minimal');
      assert.equal((await authenticate('minimal@example.test','test-admission-password')).id,minimal.user.id);
    });
  } finally {delete process.env.SIGNUP_MODE;await f.close();}
});
