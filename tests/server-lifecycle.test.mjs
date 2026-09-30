import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { access } from 'node:fs/promises';

const env = { ...process.env, WEB_CONCURRENCY: '2', REDIS_URL: 'redis://127.0.0.1:6380', LOCAL_RUNNERS: '1', MULTIPLAYER_AI_TERMINAL: '0', NEXT_TELEMETRY_DISABLED: '1' };
async function children(parent) {
  const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=']);
  return stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(([, ppid]) => ppid === parent).map(([pid]) => pid);
}
async function until(check) {
  for (let n = 0; n < 150; n++) { if (await check()) return; await delay(100); }
  throw new Error('Server lifecycle check timed out');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('cluster replaces a crashed worker and stops every child on shutdown', { skip: process.platform === 'win32', timeout: 30000 }, async () => {
  await access('.next/BUILD_ID');
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, ['scripts/serve.mjs', '--hostname', '127.0.0.1', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; const record = chunk => { output = (output + chunk).slice(-65536); };
  server.stdout.on('data', record); server.stderr.on('data', record);
  const exited = once(server, 'exit');
  const owned = new Set();
  try {
    await until(() => (output.match(/Ready in/g) ?? []).length >= 2);
    const initial = await children(server.pid); initial.forEach(pid => owned.add(pid));
    assert.equal(initial.length, 2);
    process.kill(initial[0], 'SIGKILL');
    await until(() => (output.match(/Ready in/g) ?? []).length >= 3);
    const replacement = await children(server.pid); replacement.forEach(pid => owned.add(pid));
    assert.equal(replacement.length, 2);
    assert.ok(replacement.includes(initial[1]));
    assert.ok(!replacement.includes(initial[0]));
    server.kill('SIGTERM');
    const [code] = await exited; assert.equal(code, 0);
    assert.ok([...owned].every(pid => !alive(pid)), 'no orphan workers');
    const check = createServer(); check.listen(port, '127.0.0.1'); await once(check, 'listening');
    await new Promise(resolve => check.close(resolve));
  } finally {
    if (server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await exited; }
    for (const pid of owned) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('persistent startup failures stop instead of restarting forever', { timeout: 20000 }, async () => {
  const server = spawn(process.execPath, ['scripts/serve.mjs', '--port', '-1'], { env, stdio: 'ignore' });
  const exited = once(server, 'exit');
  try { const [code] = await exited; assert.equal(code, 1); }
  finally { if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); }
});
