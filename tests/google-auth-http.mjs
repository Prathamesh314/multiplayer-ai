import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import nextEnv from '@next/env';
import { memoryFixture } from './helpers/memory-fixture.mjs';
import { issueSignupInvitation } from '../app/lib/auth/admission.ts';
import { googleBrowserCheck } from './helpers/google-browser.mjs';

nextEnv.loadEnvConfig(process.cwd());
const fixture = await memoryFixture({ postgres: true });
const servers = [];
const credentialsDirectory = await mkdtemp(join(tmpdir(), 'google-http-credentials-'));
const credentialsPath = join(credentialsDirectory, 'client.json');
let logs = '';
const freePort = async () => { const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port; };
const cookie = response => response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => value.startsWith('__Host-ma_google=') || value.startsWith('ma_auth=')).join('; ');
try {
  await writeFile(credentialsPath, JSON.stringify({web:{client_id:'http-fixture-client',client_secret:'http-fixture-secret'}}), {mode:0o600});
  const port = await freePort(), secondPort = await freePort();
  const base = `http://127.0.0.1:${port}`, second = `http://127.0.0.1:${secondPort}`;
  const database = new URL(process.env.DATABASE_URL);
  database.searchParams.set('options', globalThis.__maPool.options.options);
  for (const serverPort of [port, secondPort]) {
    const child = spawn(process.execPath, ['--import', './tests/helpers/google-provider-fixture.mjs', 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(serverPort)], {
      env: { ...process.env, DATABASE_URL: database.href, REDIS_URL: '', LOCAL_RUNNERS: '0', WEB_CONCURRENCY: '1', MNEMOSYNE_URL: '', API_TRUST_PROXY: '0',
        SIGNUP_MODE: 'invite', AUTH_PUBLIC_URL: base, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_OAUTH_CREDENTIALS_FILE: credentialsPath, GOOGLE_AUTH_HTTP_TEST: '1',
        API_RATE_AUTH_BURST: '200', API_RATE_AUTH_PER_MINUTE: '200' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    servers.push({ child, exit: once(child, 'exit') });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs+chunk).slice(-12000); });
    let ready = false;
    for (let count = 0; count < 150; count++) {
      if (child.exitCode !== null) throw Error('Test server failed: '+logs);
      try { ready = (await fetch(`http://127.0.0.1:${serverPort}/login`)).ok; } catch {}
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, 'production server starts');
  }
  const post = (path, input, jar = '', origin = base, server = base) => fetch(server+path, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie: jar, ...(origin ? { origin } : {}) }, body: JSON.stringify(input),
  });
  const begin = async (input, previousCookie = '') => {
    const response = await fetch(base+'/api/auth/google/start?'+new URLSearchParams(input), { redirect: 'manual', headers: { cookie: previousCookie } });
    assert.equal(response.status, 303); assert.match(response.headers.get('set-cookie'), /HttpOnly/i); assert.match(response.headers.get('set-cookie'), /Secure/i);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const authorization = new URL(response.headers.get('location'));
    assert.equal(authorization.origin, 'https://accounts.google.com');
    assert.equal(authorization.searchParams.get('redirect_uri'), base+'/api/auth/google/callback');
    return { authorization, jar: cookie(response) };
  };
  const callbackPath = (flow, subject, email) => {
    const params = flow.authorization.searchParams;
    const code = Buffer.from(JSON.stringify({ subject, email, nonce: params.get('nonce'), challenge: params.get('code_challenge') })).toString('base64url');
    const path = '/api/auth/google/callback?'+new URLSearchParams({ state: params.get('state'), code });
    return path;
  };
  const callback = async (flow, subject, email) => {
    const path = callbackPath(flow, subject, email);
    return { response: await fetch(second+path, { headers: { cookie: flow.jar }, redirect: 'manual' }), path };
  };

  assert.ok((await (await fetch(base+'/login')).text()).includes('Continue with Google'));
  const email = 'google-http@example.test', invite = await issueSignupInvitation(email);
  const flow = await begin({ next: '/workspace?org=second-team&connections=selected-project' });
  const missingCookie = await fetch(second+'/api/auth/google/callback?state='+flow.authorization.searchParams.get('state')+'&code=unused', { redirect: 'manual' });
  assert.ok(missingCookie.headers.get('location').includes('google_error=expired'));
  const { response, path } = await callback(flow, 'http-subject', email);
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), base+'/login?google=complete');
  assert.equal(response.headers.getSetCookie().some(value => value.startsWith('ma_auth=')), false, 'missing invitation still requires admission');
  const pending = await (await fetch(base+'/login?google=complete', { headers: { cookie: flow.jar } })).text();
  assert.ok(pending.includes(email)); assert.ok(pending.includes('Finish creating your account'));
  assert.ok(!pending.includes('http-fixture-secret')); assert.ok(!pending.includes('test-access-token-must-not-be-stored'));
  const replay = await fetch(second+path, { headers: { cookie: flow.jar }, redirect: 'manual' });
  assert.ok(replay.headers.get('location').includes('google_error=expired'));
  assert.equal((await post('/api/auth/google/complete', { handle: 'httpgoogle' }, flow.jar, 'https://attacker.example')).status, 403);
  assert.equal((await post('/api/auth/google/complete', { handle: 'httpgoogle' }, flow.jar, '')).status, 403);
  const created = await post('/api/auth/google/complete', { invitationToken: invite, email: 'forged@example.test' }, flow.jar);
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal((await created.json()).next, '/workspace?org=second-team&connections=selected-project');
  assert.match(created.headers.get('set-cookie'), /ma_auth=/);
  const signedIn = await (await fetch(base+'/api/auth/me', { headers: { cookie: cookie(created) } })).json();
  assert.equal(signedIn.user.email, email);
  assert.equal((await post('/api/auth/google/complete', { handle: 'replay' }, flow.jar)).status, 409);
  console.log('PASS: real routes verify Google token, bind state across replicas, preserve invitation/project, reject CSRF and replay, and set session cookies.');

  const returning = await begin({ next: '//attacker.example' });
  const existing = await callback(returning, 'http-subject', 'changed-google-email@example.test');
  assert.equal(existing.response.headers.get('location'), base+'/workspace');
  assert.match(existing.response.headers.get('set-cookie'), /ma_auth=/);
  const closed = await begin({});
  const cancellation = await fetch(base+'/api/auth/google/callback?'+new URLSearchParams({ state: closed.authorization.searchParams.get('state'), error: 'access_denied' }), { headers: { cookie: closed.jar }, redirect: 'manual' });
  assert.ok(cancellation.headers.get('location').includes('google_error=cancelled'));
  const retryEmail = 'google-retry@example.test';
  const retryStart = await begin({ invite: await issueSignupInvitation(retryEmail) });
  await fetch(base+'/api/auth/google/callback?'+new URLSearchParams({ state: retryStart.authorization.searchParams.get('state'), error: 'access_denied' }), { headers: { cookie: retryStart.jar }, redirect: 'manual' });
  const retry = await begin({}, retryStart.jar);
  const retried = await callback(retry, 'retry-subject', retryEmail);
  assert.equal(retried.response.headers.get('location'), base+'/workspace');
  assert.match(retried.response.headers.get('set-cookie'), /ma_auth=/, 'invited Google signup signs in without another form');
  console.log('PASS: existing Google login uses immutable identity, external redirects are rejected, and cancelled consent returns helpful feedback.');

  const verifier = randomBytes(32).toString('base64url');
  const request = await post('/api/auth/google/desktop', { challenge: createHash('sha256').update(verifier).digest('base64url') });
  assert.equal(request.status, 200);
  const desktop = await request.json();
  const desktopFlow = await begin({ desktop: desktop.id });
  const approved = await callback(desktopFlow, 'http-subject', email);
  assert.equal(approved.response.headers.get('location'), base+'/login?google=complete');
  assert.equal((await post('/api/auth/google/desktop/complete', { id: desktop.id, verifier })).status, 409);
  const confirmation = await post('/api/auth/google/complete', {}, desktopFlow.jar);
  assert.equal(confirmation.status, 200);
  assert.equal((await confirmation.json()).next, '/login?google=desktop-done');
  assert.equal((await post('/api/auth/google/desktop/complete', { id: desktop.id, verifier: 'x'.repeat(43) })).status, 409);
  const redeemed = await post('/api/auth/google/desktop/complete', { id: desktop.id, verifier });
  assert.equal(redeemed.status, 200); assert.match(redeemed.headers.get('set-cookie'), /ma_auth=/);
  assert.equal((await post('/api/auth/google/desktop/complete', { id: desktop.id, verifier })).status, 409);
  console.log('PASS: desktop transfer requires explicit approval and its original verifier, issues an app session and cannot be replayed.');
  const browserEmail = 'google-browser@example.test';
  const browserFlow = await begin({ invite: await issueSignupInvitation(browserEmail) });
  await googleBrowserCheck({ base, flow: browserFlow, callbackPath: callbackPath(browserFlow, 'browser-subject', browserEmail), email: browserEmail, authorizeDesktop: async desktopId => {
    const approval = await begin({ desktop: desktopId });
    await callback(approval, 'browser-subject', browserEmail);
    assert.equal((await post('/api/auth/google/complete', {}, approval.jar)).status, 200);
  } });
} finally {
  for (const { child } of servers) if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.all(servers.map(({ exit }) => exit));
  await fixture.close();
  await rm(credentialsDirectory,{recursive:true,force:true});
}
