// Start the built image without migrations or real credentials. Validate the
// shipped runtime and fail-closed behavior with deliberately absent services.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile), image = process.env.TEST_WEB_IMAGE ?? 'multiplayer-web:ci';
const name = 'multiplayer-image-test-'+randomUUID().slice(0, 8), secret = 'fixture-only-secret-'.repeat(4);
const docker = async args => (await run('docker', args, { timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout.trim();
await docker(['run', '--rm', image, 'node', '-e', `
  for (const module of ['node-pty','tree-sitter-go','tree-sitter-python','tree-sitter-rust','tree-sitter-typescript','pg','redis']) require(module);
  const Parser = require('tree-sitter'), parser = new Parser();
  parser.setLanguage(require('tree-sitter-javascript'));
  if (parser.parse('const answer = 42;').rootNode.hasError) throw new Error('Native parser failed');
  console.log('Native parsing and database modules work');
`]);
await docker(['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::3000',
  '-e', 'DATABASE_URL=postgres://fixture:fixture@127.0.0.1:1/fixture', '-e', 'REDIS_URL=redis://127.0.0.1:1',
  '-e', 'LOCAL_RUNNERS=1', '-e', 'AGENT_WORKER=0', '-e', 'MULTIPLAYER_AI_TERMINAL=0', '-e', 'API_TRUST_PROXY=1',
  '-e', `PROXY_SHARED_SECRET=${secret}`, image, 'node', 'scripts/serve.mjs', '-H', '0.0.0.0', '-p', '3000']);
try {
  const address = await docker(['port', name, '3000/tcp']);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const base = 'http://'+address;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base+'/login', { signal: AbortSignal.timeout(2000) })).ok) { ready = true; break; } } catch {}
    await delay(100);
  }
  assert.ok(ready, 'container serves the production login page');
  assert.equal((await fetch(base+'/health/ready')).status, 503, 'missing dependencies make image unready');
  assert.equal((await fetch(base+'/api/auth/me')).status, 403, 'direct API bypass is refused');
  const protectedResponse = await fetch(base+'/api/auth/me', { headers: { 'x-multiplayer-proxy-secret': secret, 'x-multiplayer-client-ip': '192.0.2.1' } });
  assert.equal(protectedResponse.status, 503);
  assert.equal(protectedResponse.headers.get('retry-after'), '2');
  console.log('PASS: production container boots, native dependencies load, private API gate and dependency failure responses work.');
} catch (error) {
  console.error(await docker(['logs', '--tail', '50', name]));
  throw error;
} finally { await docker(['stop', '--time', '2', name]); }
