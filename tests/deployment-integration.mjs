// Real Redis + two production Next processes + the checked-in Caddy gateway.
// Uses a disposable PostgreSQL schema and test-owned containers only.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import nextEnv from '@next/env';
import { createClient } from 'redis';
import { memoryFixture } from './helpers/memory-fixture.mjs';
import { redisLimitStore } from '../app/lib/http/rate-limit.ts';

nextEnv.loadEnvConfig(process.cwd(), true);
const run = promisify(execFile), containers = [], processes = [], servers = [], clients = [];
const secret = randomBytes(32).toString('hex');
const root = await mkdtemp(join(tmpdir(), 'multiplayer-deployment-'));
const downloads = join(root, 'downloads');
await mkdir(join(downloads, 'preview-test'), { recursive: true });
const installer = Buffer.from('verified-preview-installer-fixture');
await writeFile(join(downloads, 'preview-test', 'app.exe'), installer);
let fixture;
async function docker(args, options = {}) { return (await run('docker', args, { maxBuffer: 1024 * 1024, ...options })).stdout.trim(); }
async function eventually(check, label, attempts = 150) {
  for (let n = 0; n < attempts; n++) { if (await check()) return; await delay(100); }
  throw Error(`Timed out: ${label}`);
}
async function listen(server, host = '0.0.0.0') {
  server.listen(0, host); await once(server, 'listening'); return server.address().port;
}
async function startContainer(args, targetPort) {
  const name = 'multiplayer-deploy-test-'+randomUUID().slice(0, 8);
  await docker(['run', '--rm', '-d', '--name', name, '-p', `127.0.0.1::${targetPort}`, ...args]);
  containers.push(name);
  const address = await docker(['port', name, `${targetPort}/tcp`]);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  return { name, address };
}
async function gateway(ports) {
  const started = await startContainer(['--add-host=host.docker.internal:host-gateway',
    '-e', 'APP_DOMAIN=:8080', '-e', 'ACME_EMAIL=fixture@example.com', '-e', `PROXY_SHARED_SECRET=${secret}`,
    '-e', `APP_UPSTREAMS=${ports.map(port => `host.docker.internal:${port}`).join(' ')}`,
    '-v', `${downloads}:/srv/desktop-downloads:ro`,
    '-v', `${resolve('docker/gateway/Caddyfile')}:/etc/caddy/Caddyfile:ro`, 'caddy:2.11.2-alpine'], 8080);
  const adapted = JSON.parse(await docker(['exec', started.name, 'caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']));
  for (const server of Object.values(adapted.apps.http.servers)) {
    assert.equal(server.allow_0rtt, false, 'gateway waits for a verified client address before forwarding to IP-based admission');
  }
  const base = 'http://'+started.address;
  await eventually(async () => { try { return (await fetch(base+'/health/ready')).status === 404; } catch { return false; } }, 'gateway startup');
  return base;
}

try {
  // Validate actual Compose output, including the environment and port merging.
  const config = JSON.parse(await docker(['compose', '--env-file', '/dev/null', '-f', 'compose.production.yml', 'config', '--format', 'json'], {
    env: { ...process.env, POSTGRES_PASSWORD: 'test-only-password', MNEMOSYNE_MCP_TOKEN: secret,
      PROXY_SHARED_SECRET: secret, APP_DOMAIN: 'example.com', ACME_EMAIL: 'fixture@example.com' },
  }));
  for (const [name, service] of Object.entries(config.services)) if (name !== 'gateway') assert.equal(service.ports, undefined, `${name} is private`);
  assert.equal(config.services.web.image, config.services.web2.image);
  assert.deepEqual(config.services.web.volumes, config.services.web2.volumes);
  assert.deepEqual(config.services.web.volumes, config.services.worker.volumes);
  for (const name of ['web', 'web2']) {
    assert.equal(config.services[name].environment.API_TRUST_PROXY, '1');
    assert.equal(config.services[name].environment.WEB_CONCURRENCY, '1');
    assert.equal(config.services[name].depends_on.migrate.condition, 'service_completed_successfully');
  }
  console.log('PASS: private backing services, shared Git volume/image and single migration owner.');

  fixture = await memoryFixture({ postgres: true });
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.searchParams.set('options', globalThis.__maPool.options.options);
  const redis = await startContainer(['redis:7-alpine', 'redis-server', '--save', '', '--appendonly', 'no'], 6379);
  const redisUrl = 'redis://'+redis.address;
  const control = createClient({ url: redisUrl });
  control.on('error', () => {}); await control.connect(); clients.push(() => { if (control.isOpen) control.destroy(); });
  const stores = [redisLimitStore(redisUrl), redisLimitStore(redisUrl)];
  clients.push(...stores.map(item => item.close));
  await Promise.all(stores.map(item => item.store.ready())); // First call waits for the healthy initial handshake.
  const admissions = await Promise.all(Array.from({ length: 200 }, (_, i) => stores[i % 2].store.take('test:race', { name: 'test', burst: 10, perMinute: 1 })));
  assert.equal(admissions.filter(result => result.allowed).length, 10, 'two clients cannot overspend a shared bucket');
  assert.ok(await control.pTTL('test:race') > 0);
  console.log('PASS: 200 concurrent Redis admissions share exactly 10 tokens.');

  const tokens = [];
  for (const user of [fixture.alice, fixture.alice, fixture.bob]) {
    const token = randomBytes(32).toString('hex'); tokens.push(token);
    await fixture.db.query("INSERT INTO auth_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [user, createHash('sha256').update(token).digest()]);
  }
  const deviceTokens = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
  for (const token of deviceTokens) await fixture.db.query("INSERT INTO runner_devices(user_id,name,token_hash) VALUES ($1,'fixture',$2)", [fixture.alice, createHash('sha256').update(token).digest()]);
  const ports = [];
  for (let i = 0; i < 2; i++) {
    const probe = createServer(), port = await listen(probe); await new Promise(resolve => probe.close(resolve)); ports.push(port);
    const child = spawn(process.execPath, ['scripts/serve.mjs', '-H', '0.0.0.0', '-p', String(port)], {
      env: { ...process.env, NODE_ENV: 'production', NEXT_TEST_DIST_DIR: process.env.NEXT_TEST_DIST_DIR || '.next', NEXT_TELEMETRY_DISABLED: '1',
        DATABASE_URL: databaseUrl.href, REDIS_URL: redisUrl, MULTIPLAYER_AI_DATA: root, MNEMOSYNE_URL: '', REPO_EMBEDDING_URL: '',
        LOCAL_RUNNERS: '1', AGENT_WORKER: '0', MULTIPLAYER_AI_TERMINAL: '0', WEB_CONCURRENCY: '1',
        API_TRUST_PROXY: '1', PROXY_SHARED_SECRET: secret, API_RATE_NAMESPACE: 'deployment-test',
        API_RATE_READ_PER_MINUTE: '1', API_RATE_READ_BURST: '4', API_RATE_AUTH_PER_MINUTE: '1', API_RATE_AUTH_BURST: '2',
        API_RATE_RUNNER_PER_MINUTE: '1', API_RATE_RUNNER_BURST: '2' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = { child, exited: once(child, 'exit'), output: '' }; processes.push(record);
    const collect = data => { record.output = (record.output+data).slice(-65536); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    await eventually(async () => {
      if (child.exitCode !== null) throw Error('Next server exited: '+record.output);
      try { return (await fetch(`http://127.0.0.1:${port}/health/ready`)).ok; } catch { return false; }
    }, 'Next readiness', 300);
  }
  const headers = (token = tokens[0]) => ({ cookie: `ma_auth=${token}`, 'x-multiplayer-proxy-secret': secret, 'x-multiplayer-client-ip': '192.0.2.1' });
  const direct = (i, token = tokens[0], path = '/api/auth/me', extra = {}) => fetch(`http://127.0.0.1:${ports[i]}${path}`, { headers: { ...headers(token), ...extra } });
  for (let i = 0; i < 4; i++) {
    const token = i === 3 ? [...tokens[1]].map(char => '%'+char.charCodeAt(0).toString(16)).join('') : tokens[i % 2];
    assert.equal((await direct(i % 2, token)).status, 200);
  }
  const blocked = await direct(1, tokens[1], '/api/orgs?fresh=1', { 'x-user-id': fixture.bob, 'x-forwarded-for': '203.0.113.99', 'x-multiplayer-client-ip': '192.0.2.2' });
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await direct(0, tokens[2], '/api/auth/me', { cookie: `ma_auth=${tokens[2]}; ma_auth=${tokens[0]}` })).status, 429, 'duplicate-cookie precedence matches authentication');
  assert.equal((await direct(0, tokens[2])).status, 200, 'another user has a separate allowance');
  assert.equal((await fetch(`http://127.0.0.1:${ports[0]}/api/auth/me`, { headers: { cookie: `ma_auth=${tokens[2]}` } })).status, 403, 'missing gateway credential rejected');
  for (let i = 0; i < 2; i++) assert.equal((await direct(i, '', '/api/runner/me', { authorization: `Bearer ${deviceTokens[i]}` })).status, 200);
  assert.equal((await direct(0, '', '/api/runner/me', { authorization: `Bearer ${deviceTokens[0]}` })).status, 429, 'devices share owner budget');
  console.log('PASS: real API limits shared across two processes, browser sessions and devices; users isolated.');

  await control.flushDb(); // This Redis container is exclusively owned by this test.
  const base = await gateway(ports);
  const spoofed = { 'x-multiplayer-proxy-secret': 'forged', 'x-multiplayer-client-ip': '1.2.3.4', 'x-forwarded-for': '8.8.8.8' };
  assert.equal((await fetch(base+'/api/auth/me', { headers: { cookie: `ma_auth=${tokens[0]}`, ...spoofed } })).status, 200);
  for (let i = 0; i < 3; i++) {
    const response = await fetch(base+'/api/auth/login', { method: 'POST', headers: { ...spoofed, 'x-multiplayer-client-ip': `192.0.2.${i}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, i < 2 ? 400 : 429);
  }
  await fixture.db.query('UPDATE auth_tokens SET revoked_at=now() WHERE token_hash=$1', [createHash('sha256').update(tokens[0]).digest()]);
  assert.equal((await (await fetch(base+'/api/auth/me', { headers: { cookie: `ma_auth=${tokens[0]}` } })).json()).user, null, 'revocation remains live');
  await docker(['stop', '--time', '1', redis.name]);
  await eventually(async () => (await direct(0, tokens[2])).status === 503, 'Redis outage fails closed');
  assert.equal((await fetch(`http://127.0.0.1:${ports[0]}/health/ready`)).status, 503);
  console.log('PASS: real gateway overwrites spoofed headers; live revocation and Redis-outage readiness work.');

  // Exercise the actual gateway config against controllable upstreams. This
  // makes distribution, stream flushing and no mutation replay observable.
  const states = [{ id: 'first', ready: true, writes: 0 }, { id: 'second', ready: true, writes: 0 }];
  const upstreamPorts = [];
  for (const state of states) {
    const server = createServer(async (request, response) => {
      response.setHeader('x-test-upstream', state.id);
      if (request.url === '/health/ready') { response.writeHead(state.ready ? 200 : 503).end(); return; }
      if (request.url === '/events') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        response.write('event: ready\ndata: {}\n\n');
        const timer = setInterval(() => response.write(': keepalive\n\n'), 1000);
        response.on('close', () => clearInterval(timer)); return;
      }
      if (request.method === 'POST') {
        state.writes++;
        if (request.url === '/uncertain') { request.socket.destroy(); return; }
        const hash = createHash('sha256'); for await (const chunk of request) hash.update(chunk);
        response.end(hash.digest('hex')); return;
      }
      response.end(state.id);
    });
    servers.push(server); upstreamPorts.push(await listen(server));
  }
  const gatewayBase = await gateway(upstreamPorts);
  const downloadUrl = gatewayBase+'/downloads/desktop/preview-test/app.exe';
  const head = await fetch(downloadUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), installer.length);
  assert.equal(head.headers.get('content-disposition'), 'attachment');
  assert.equal(head.headers.get('x-content-type-options'), 'nosniff');
  assert.match(head.headers.get('cache-control'), /immutable/);
  assert.equal(head.headers.get('x-test-upstream'), null, 'downloads bypass application replicas');
  assert.deepEqual(Buffer.from(await (await fetch(downloadUrl)).arrayBuffer()), installer);
  const range = await fetch(downloadUrl, { headers: { range: 'bytes=3-9' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 3-9/${installer.length}`);
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), installer.subarray(3, 10));
  for (const path of ['/downloads/desktop/preview-test/', '/downloads/desktop/missing.exe', '/health/ready']) {
    const missing = await fetch(gatewayBase+path);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(missing.headers.get('cache-control') || '', /immutable/, 'missing downloads must not be cached as a release');
  }
  console.log('PASS: public installer bytes, resumable downloads, no directory listing and private health endpoint.');
  const seen = new Set(await Promise.all(Array.from({ length: 12 }, async () => (await fetch(gatewayBase+'/')).text())));
  assert.equal(seen.size, 2, 'both upstreams receive traffic');
  const streaming = await fetch(gatewayBase+'/events', { signal: AbortSignal.timeout(20_000) });
  const reader = streaming.body.getReader();
  const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /event: ready/);
  const busy = streaming.headers.get('x-test-upstream');
  for (let i = 0; i < 5; i++) assert.notEqual((await fetch(gatewayBase+'/')).headers.get('x-test-upstream'), busy, 'least connections avoids the occupied stream upstream');
  await reader.cancel();
  const bytes = Buffer.alloc(12 * 1024 * 1024, 93);
  const uploaded = await fetch(gatewayBase+'/upload', { method: 'POST', body: bytes });
  assert.equal(await uploaded.text(), createHash('sha256').update(bytes).digest('hex'), 'large upload preserved');
  const before = states.reduce((sum, state) => sum+state.writes, 0);
  assert.equal((await fetch(gatewayBase+'/uncertain', { method: 'POST', body: 'one mutation' })).status, 502);
  assert.equal(states.reduce((sum, state) => sum+state.writes, 0)-before, 1, 'uncertain mutations are never replayed');
  states[0].ready = false;
  await delay(11_000);
  for (let i = 0; i < 8; i++) assert.equal(await (await fetch(gatewayBase+'/')).text(), 'second', 'unhealthy upstream removed');
  console.log('PASS: least-connection distribution, immediate SSE, 12 MiB upload, health failover and no mutation replay.');
} finally {
  for (const record of processes) {
    if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGTERM');
    await record.exited;
  }
  for (const close of clients) close();
  for (const name of containers.reverse()) await docker(['stop', '--time', '1', name]).catch(() => {});
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fixture?.close();
  await rm(root, { recursive: true, force: true });
}
