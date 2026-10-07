import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { memoryFixture } from './helpers/memory-fixture.mjs';
import { authDigest, googleConfigured, googleConfig, verifyGoogleToken } from '../app/lib/auth/google-provider.ts';
import { beginGoogleAuth, claimGoogleCallback, saveGoogleProfile, pendingGoogleProfile, completeGoogleAuth,
  finishGoogleBrowserAuth, finishExistingGoogleAuth, createGoogleDesktopSignin, redeemGoogleDesktopSignin } from '../app/lib/auth/google-store.ts';
import { issueSignupInvitation } from '../app/lib/auth/admission.ts';
import { authenticate, createUser } from '../app/lib/repo/users.ts';
import { inviteByEmail, acceptInvitationByToken } from '../app/lib/org/store.ts';
import nextEnv from '@next/env';
if (process.env.GOOGLE_AUTH_TEST_POSTGRES === '1') nextEnv.loadEnvConfig(process.cwd());
import { policyFor } from '../app/lib/http/api-limit.ts';

const envKeys = ['SIGNUP_MODE', 'AUTH_PUBLIC_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CREDENTIALS_FILE'];
const settings = () => { delete process.env.GOOGLE_OAUTH_CREDENTIALS_FILE; Object.assign(process.env, { SIGNUP_MODE: 'invite', AUTH_PUBLIC_URL: 'https://workspace.example', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-only-secret' }); };
const restore = values => { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };

test('Google verifies signed identity claims and fixed public origin', async () => {
  const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  settings();
  try {
    assert.equal(googleConfigured(), true);
    assert.equal(googleConfig().redirectUri, 'https://workspace.example/api/auth/google/callback');
    for (const origin of ['http://workspace.example', 'https://user:password@workspace.example', 'https://workspace.example/path', 'https://workspace.example?x=1', '']) {
      process.env.AUTH_PUBLIC_URL = origin; assert.equal(googleConfigured(), false);
    }
    settings();
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256' }] });
    const nonce = randomBytes(32).toString('base64url');
    const claims = { sub: 'immutable-google-subject', email: 'verified@example.test', email_verified: true, nonce,
      name: 'Verified User', iss: 'https://accounts.google.com', aud: 'test-client', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300 };
    const sign = values => new SignJWT(values).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(privateKey);
    assert.deepEqual(await verifyGoogleToken(await sign(claims), authDigest(nonce), 'test-client', keys), {
      subject: claims.sub, email: claims.email, displayName: claims.name,
    });
    for (const changed of [{ iss: 'https://attacker.example' }, { aud: 'another-client' }, { azp: 'another-client' },
      { nonce: 'wrong' }, { email_verified: false }, { email_verified: 'true' }, { email: 'invalid' }, { sub: '' },
      { exp: Math.floor(Date.now()/1000)-60 }, { iat: Math.floor(Date.now()/1000)+120 }]) {
      await assert.rejects(verifyGoogleToken(await sign({ ...claims, ...changed }), authDigest(nonce), 'test-client', keys));
    }
    const forged = (await sign(claims)).split('.');
    forged[1] = Buffer.from(JSON.stringify({ ...claims, email: 'victim@example.test' })).toString('base64url');
    await assert.rejects(verifyGoogleToken(forged.join('.'), authDigest(nonce), 'test-client', keys));
    const missing = { ...claims }; delete missing.nonce;
    await assert.rejects(verifyGoogleToken(await sign(missing), authDigest(nonce), 'test-client', keys));
    for (const route of ['start', 'callback', 'complete', 'desktop', 'desktop/complete']) assert.equal(policyFor('/api/auth/google/'+route, 'POST'), 'auth');
  } finally { restore(before); }
});

test('Google reads server-only Web client JSON and rejects invalid files without revealing secrets', async () => {
  const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const directory = await mkdtemp(join(tmpdir(), 'google-credentials-'));
  settings();
  try {
    const path = join(directory, 'client.json');
    process.env.GOOGLE_OAUTH_CREDENTIALS_FILE = path;
    assert.equal(googleConfigured(), false, 'missing file cannot silently fall back to another client');
    await writeFile(path, JSON.stringify({web: {client_id:'file-client',client_secret:'file-secret',token_uri:'https://attacker.example',redirect_uris:['https://attacker.example']}}));
    assert.equal(googleConfig().clientId, 'file-client');
    assert.equal(googleConfig().clientSecret, 'file-secret');
    assert.equal(googleConfig().redirectUri, 'https://workspace.example/api/auth/google/callback');
    for (const invalid of ['file-secret INVALID JSON', 'null', '{}', JSON.stringify({installed:{client_id:'desktop-client',client_secret:'file-secret'}}), 'x'.repeat(65537)]) {
      await writeFile(path, invalid);
      assert.equal(googleConfigured(), false);
      assert.throws(googleConfig, error => error.status === 503 && !error.message.includes('file-secret') && !error.message.includes(directory));
    }
    delete process.env.GOOGLE_OAUTH_CREDENTIALS_FILE;
    assert.equal(googleConfig().clientId, 'test-client', 'individual environment values remain supported');
  } finally { restore(before); await rm(directory, {recursive:true,force:true}); }
});

test('Google signup, account linking, invitations and desktop transfer', async t => {
  const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  settings();
  const f = await memoryFixture({ postgres: process.env.GOOGLE_AUTH_TEST_POSTGRES === '1' });
  const verified = async (email, subject, input = {}) => {
    const flow = await beginGoogleAuth({ next: '/workspace?org=team&connections=project', ...input });
    await claimGoogleCallback(flow.token, new URL(flow.url).searchParams.get('state'));
    await saveGoogleProfile(flow.token, { email, subject, displayName: 'Google User' });
    return flow;
  };
  let googleUser;
  try {
    await t.test('state is browser-bound, single-use, expiring and uses PKCE', async () => {
      const flow = await beginGoogleAuth({ next: '//attacker.example' });
      const authorization = new URL(flow.url);
      assert.equal(authorization.origin, 'https://accounts.google.com');
      assert.equal(authorization.searchParams.get('scope'), 'openid email profile');
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorization.searchParams.has('client_secret'), false);
      const state = authorization.searchParams.get('state');
      await assert.rejects(claimGoogleCallback('x'.repeat(43), state));
      await assert.rejects(claimGoogleCallback(flow.token, 'x'.repeat(43)));
      const race = await Promise.allSettled([claimGoogleCallback(flow.token, state), claimGoogleCallback(flow.token, state)]);
      assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
      const row = race.find(r => r.status === 'fulfilled').value;
      assert.equal(row.return_path, '/workspace');
      assert.equal(authDigest(row.code_verifier).toString('base64url'), authorization.searchParams.get('code_challenge'));
      const stale = await beginGoogleAuth({});
      await f.db.query("UPDATE google_auth_flows SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [authDigest(stale.token)]);
      await assert.rejects(claimGoogleCallback(stale.token, new URL(stale.url).searchParams.get('state')));
    });
    await t.test('invitation admission remains enforced without creating partial users', async () => {
      const flow = await verified('new@example.test', 'new-subject');
      assert.equal(await finishGoogleBrowserAuth(flow.token), null);
      await assert.rejects(completeGoogleAuth(flow.token, { handle: 'googleuser' }), /invitation/);
      assert.equal(await f.first("SELECT id FROM users WHERE email='new@example.test'"), undefined);
      const invitationToken = await issueSignupInvitation('different@example.test');
      await assert.rejects(completeGoogleAuth(flow.token, { handle: 'googleuser', invitationToken }), /invitation/);
    });
    await t.test('handle retry keeps invitation, successful signup consumes it and binds immutable subject', async () => {
      const invitationToken = await issueSignupInvitation('google@example.test');
      const flow = await verified('google@example.test', 'google-subject', { invitationToken });
      await assert.rejects(completeGoogleAuth(flow.token, { handle: 'alice' }), /username is taken/);
      assert.equal((await f.first("SELECT used_at FROM signup_invitations WHERE email='google@example.test'")).used_at, null);
      const row = await f.first('SELECT invitation_hash FROM google_auth_flows WHERE token_hash=$1', [authDigest(flow.token)]);
      assert.deepEqual(Buffer.from(row.invitation_hash), authDigest(invitationToken));
      const result = await completeGoogleAuth(flow.token, { handle: 'googleuser', email: 'attacker@example.test' });
      googleUser = result.user;
      assert.equal(result.user.email, 'google@example.test');
      assert.equal(result.next, '/workspace?org=team&connections=project');
      assert.equal((await f.first('SELECT password_hash FROM users WHERE id=$1', [googleUser.id])).password_hash, null);
      assert.equal(await authenticate('google@example.test', 'any-password'), null);
      assert.equal((await f.first("SELECT user_id FROM user_identities WHERE provider_user_id='google-subject'")).user_id, googleUser.id);
      await assert.rejects(completeGoogleAuth(flow.token, { handle: 'another' }), /expired|already used/);
      const replay = await verified('google@example.test', 'different-subject', { invitationToken });
      await assert.rejects(completeGoogleAuth(replay.token, { handle: 'takeover' }), /original sign-in/);
    });
    await t.test('existing Google identities sign in with signup closed and a changed email', async () => {
      process.env.SIGNUP_MODE = 'closed';
      const flow = await verified('changed@example.test', 'google-subject');
      const result = await finishExistingGoogleAuth(flow.token);
      assert.equal(result.user.id, googleUser.id);
      assert.equal(result.user.email, 'google@example.test');
      assert.equal(await finishExistingGoogleAuth(flow.token), null);
      await assert.rejects(finishGoogleBrowserAuth(flow.token), /expired/);
      const newcomer = await verified('closed@example.test', 'closed-subject');
      assert.equal(await finishGoogleBrowserAuth(newcomer.token), null);
      await assert.rejects(completeGoogleAuth(newcomer.token, { handle: 'closeduser' }), /closed/);
      process.env.SIGNUP_MODE = 'invite';
    });
    await t.test('matching email alone cannot take over a password account', async () => {
      const invitationToken = await issueSignupInvitation('password@example.test');
      const created = await createUser({ handle: 'passworduser', email: 'password@example.test', displayName: 'Password User', password: 'original-test-password', invitationToken });
      assert.equal(created.ok, true);
      const flow = await verified('PASSWORD@example.test', 'linked-subject');
      assert.equal((await pendingGoogleProfile(flow.token)).mode, 'link');
      assert.equal(await finishExistingGoogleAuth(flow.token), null);
      assert.equal(await finishGoogleBrowserAuth(flow.token), null);
      await assert.rejects(completeGoogleAuth(flow.token, {}), /existing account password/);
      await assert.rejects(completeGoogleAuth(flow.token, { password: 'incorrect' }), /existing account password/);
      const linked = await completeGoogleAuth(flow.token, { password: 'original-test-password' });
      assert.equal(linked.user.id, created.user.id);
      assert.ok((await f.first('SELECT email_verified_at FROM users WHERE id=$1', [created.user.id])).email_verified_at, 'linking confirms the matching email through Google');
      assert.ok(await authenticate('password@example.test', 'original-test-password'));
      const other = await verified('password@example.test', 'another-google-subject');
      await assert.rejects(completeGoogleAuth(other.token, { password: 'original-test-password' }), /different Google account/);
    });
    await t.test('org invitations preserve explicit org membership acceptance', async () => {
      const invite = await inviteByEmail(f.org, 'google-teammate@example.test', 'member', f.alice);
      assert.equal(invite.ok, true);
      const flow = await verified('google-teammate@example.test', 'teammate-subject', { invitationToken: invite.token, next: '/invite/'+invite.token });
      const result = await completeGoogleAuth(flow.token, { handle: 'googleteammate' });
      assert.equal(result.next, '/invite/'+invite.token);
      assert.equal((await acceptInvitationByToken(invite.token, result.user.id)).ok, true);
    });
    await t.test('desktop authorization requires approval and the initiating app secret; replay fails', async () => {
      const verifier = randomBytes(32).toString('base64url');
      const request = await createGoogleDesktopSignin(authDigest(verifier).toString('base64url'));
      await assert.rejects(redeemGoogleDesktopSignin(request.id, verifier), /browser first/);
      const flow = await verified('google@example.test', 'google-subject', { desktopId: request.id });
      assert.equal(await finishExistingGoogleAuth(flow.token), null);
      assert.equal(await finishGoogleBrowserAuth(flow.token), null);
      const pending = await pendingGoogleProfile(flow.token);
      assert.equal(pending.mode, 'signin'); assert.equal(pending.desktopCode, request.code);
      assert.equal((await completeGoogleAuth(flow.token, {})).next, '/login?google=desktop-done');
      await assert.rejects(redeemGoogleDesktopSignin(request.id, 'x'.repeat(43)));
      const results = await Promise.allSettled([redeemGoogleDesktopSignin(request.id, verifier), redeemGoogleDesktopSignin(request.id, verifier)]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.find(r => r.status === 'fulfilled').value.id, googleUser.id);
      const stale = await createGoogleDesktopSignin(authDigest(verifier).toString('base64url'));
      await f.db.query("UPDATE google_desktop_signins SET expires_at=now()-interval '1 second' WHERE id=$1", [stale.id]);
      await assert.rejects(beginGoogleAuth({ desktopId: stale.id }));
      await assert.rejects(redeemGoogleDesktopSignin(stale.id, verifier));
    });
    await t.test('open browser signup generates a unique handle and admits without an invitation', async () => {
      process.env.SIGNUP_MODE = 'open';
      const flows = await Promise.all(['first', 'second'].map(id => verified(id+'@example.test', 'open-'+id)));
      const results = await Promise.all(flows.map(flow => finishGoogleBrowserAuth(flow.token)));
      assert.notEqual(results[0].user.handle, results[1].user.handle);
      for (const result of results) {
        assert.match(result.user.handle, /^[a-z0-9][a-z0-9_-]{1,38}$/);
        const stored = await f.first('SELECT password_hash,email_verified_at FROM users WHERE id=$1', [result.user.id]);
        assert.equal(stored.password_hash, null);
        assert.ok(stored.email_verified_at);
      }
      process.env.SIGNUP_MODE = 'invite';
    });
    await t.test('deleted accounts cannot return through Google', async () => {
      await f.db.query('UPDATE users SET deleted_at=now() WHERE id=$1', [googleUser.id]);
      const flow = await verified('google@example.test', 'google-subject');
      await assert.rejects(finishExistingGoogleAuth(flow.token), /unavailable/);
      await assert.rejects(completeGoogleAuth(flow.token, {}), /unavailable/);
    });
  } finally {
    await f.close();
    restore(before);
  }
});
