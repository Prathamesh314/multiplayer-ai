import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { MemoryLimitStore, limitKey } from '../app/lib/http/rate-limit.ts';
import { admitApiRequest, clientAddress, policyFor, policy, usesDeviceToken, withApiLimit } from '../app/lib/http/api-limit.ts';

test('token bucket admits a burst, refills gradually and rejects atomically', async () => {
  let now = 0;
  const store = new MemoryLimitStore(() => now);
  const rule = { name: 'test', perMinute: 60, burst: 3 };
  const results = await Promise.all(Array.from({ length: 100 }, () => store.take('alice', rule)));
  assert.equal(results.filter(result => result.allowed).length, 3);
  assert.equal(results.at(-1).retryAfter, 1);
  now = 500;
  assert.equal((await store.take('alice', rule)).allowed, false);
  now = 1000;
  assert.equal((await store.take('alice', rule)).allowed, true);
  assert.equal((await store.take('bob', rule)).allowed, true);
  now = 100_000;
  assert.equal((await store.take('alice', rule)).remaining, 2);
});

test('memory fallback bounds key count without evicting active protection', async () => {
  let now = 0;
  const store = new MemoryLimitStore(() => now, 1), rule = policy('auth', {});
  await store.take('alice', rule);
  await assert.rejects(store.take('bob', rule), /capacity/);
  now = 60_000;
  assert.equal((await store.take('bob', rule)).allowed, true);
  assert.ok(!limitKey('test', 'private-token-or-ip', rule).includes('private-token-or-ip'));
});

test('proxy address needs authenticated headers; spoofed forwarding headers are ignored', () => {
  const env = { API_TRUST_PROXY: '1', PROXY_SHARED_SECRET: 'a'.repeat(64) };
  const make = (ip, secret = env.PROXY_SHARED_SECRET) => new Request('http://test/api/tasks', { headers: {
    'x-multiplayer-client-ip': ip, 'x-multiplayer-proxy-secret': secret, 'x-forwarded-for': '8.8.8.8',
  } });
  assert.equal(clientAddress(make('192.0.2.1'), env), '192.0.2.1');
  assert.equal(clientAddress(make('192.0.2.1', 'wrong'), env), null);
  assert.equal(clientAddress(make('192.0.2.1', 'é'.repeat(64)), env), null);
  assert.equal(clientAddress(make('192.0.2.1, 1.1.1.1'), env), null);
  assert.equal(clientAddress(make('2001:db8:abcd:12::1'), env), clientAddress(make('2001:db8:abcd:12::99'), env));
  assert.equal(clientAddress(make('::ffff:192.0.2.1'), env), '192.0.2.1');
  assert.equal(clientAddress(make('1.1.1.1'), {}), 'direct');
  assert.throws(() => clientAddress(make('1.1.1.1'), { API_TRUST_PROXY: '1' }), /secret/);
});

test('a user shares limits across credentials, routes, query strings and IPs', async () => {
  const store = new MemoryLimitStore();
  const env = { API_RATE_READ_BURST: '2', API_RATE_READ_PER_MINUTE: '1' };
  const deps = { store: () => store, env, userId: async request => request.headers.get('test-user') };
  const make = user => new Request('http://test/api/tasks?random=1', { headers: { 'test-user': user } });
  assert.ok(await admitApiRequest(make('alice'), '/api/tasks', deps) instanceof Headers);
  assert.ok(await admitApiRequest(make('alice'), '/api/orgs', deps) instanceof Headers);
  const blocked = await admitApiRequest(make('alice'), '/api/sessions', deps);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal(blocked.headers.get('cache-control'), 'no-store');
  assert.ok(await admitApiRequest(make('bob'), '/api/tasks', deps) instanceof Headers);
  assert.ok(await admitApiRequest(new Request('http://test/api/tasks', { method: 'POST', headers: { 'test-user': 'alice' } }), '/api/tasks', deps) instanceof Headers);
});

test('credential attempts consume IP limits even with a valid user cookie', async () => {
  const store = new MemoryLimitStore();
  const deps = { store: () => store, env: { API_RATE_AUTH_BURST: '2', API_RATE_AUTH_PER_MINUTE: '1' },
    userId: async () => { throw Error('credential attempts must not resolve a session'); } };
  for (const route of ['/api/auth/login', '/api/auth/register']) {
    assert.ok(await admitApiRequest(new Request('http://test'+route, { method: 'POST' }), route, deps) instanceof Headers);
  }
  assert.equal((await admitApiRequest(new Request('http://test/api/auth/continue', { method: 'POST' }), '/api/auth/continue', deps)).status, 429);
});

test('Redis or identity failures fail closed, including a failure during the second debit', async () => {
  for (const failOn of [1, 2]) {
    let calls = 0;
    const deps = { env: {}, userId: async () => 'alice', store: () => ({ take: async () => {
      if (++calls === failOn) throw Error('private connection details');
      return { allowed: true, remaining: 1, retryAfter: 0, resetAfter: 1 };
    } }) };
    const response = await admitApiRequest(new Request('http://test/api/tasks'), '/api/tasks', deps);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '2');
    assert.ok(!(await response.text()).includes('private'));
  }
});

test('stream starts, uploads and runner control have separate bounded budgets', () => {
  assert.equal(policyFor('/api/sessions/[id]/events', 'GET'), 'stream');
  assert.equal(policyFor('/api/sessions/[id]/events', 'HEAD'), 'stream');
  assert.equal(policyFor('/api/runner/runs/[runId]/events', 'POST'), 'activity');
  assert.equal(policyFor('/api/runner/runs/[runId]/complete', 'POST'), 'runner');
  assert.equal(policyFor('/api/runner/runs/[runId]/checkpoints', 'POST'), 'runner');
  assert.equal(policyFor('/api/git/[repoRef]/[...op]', 'POST'), 'git');
  assert.equal(policyFor('/api/sessions/[id]/repos/[repoId]/seed', 'POST'), 'upload');
  assert.equal(usesDeviceToken('/api/runner/devices'), false);
  assert.equal(usesDeviceToken('/api/runner/me'), true);
  for (const value of ['0', '-1', 'Infinity', 'NaN', '1.5']) assert.throws(() => policy('read', { API_RATE_READ_BURST: value }));
});

test('the API wrapper preserves large bodies, stream responses, cookies and route context', async () => {
  const before = globalThis.__maLimits;
  globalThis.__maLimits = new MemoryLimitStore();
  try {
    const bytes = 'x'.repeat(12 * 1024 * 1024);
    const handler = withApiLimit('/api/test', async (request, context) => {
      assert.equal(await request.text(), bytes);
      assert.equal((await context.params).id, 'fixture');
      return new Response('event: ready\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'fixture=ok; HttpOnly' } });
    });
    const response = await handler(new Request('http://test/api/test', { method: 'POST', body: bytes }), { params: Promise.resolve({ id: 'fixture' }) });
    assert.match(await response.text(), /event: ready/);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('set-cookie'), 'fixture=ok; HttpOnly');
    assert.ok(response.headers.has('x-ratelimit-remaining'));
  } finally { globalThis.__maLimits = before; }
});

test('every exported API method uses the shared limiter with its actual route template', async () => {
  async function walk(path) {
    const result = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) result.push(...await walk(file));
      else if (entry.name === 'route.ts') result.push(file);
    }
    return result;
  }
  let checked = 0;
  for (const path of await walk('app/api')) {
    const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      assert.ok(!ts.isExportDeclaration(statement), `no unchecked re-export: ${path}`);
      if (ts.isFunctionDeclaration(statement)) assert.ok(!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(statement.name?.text), `unwrapped function: ${path}`);
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(declaration.name.getText(source))) continue;
        const init = declaration.initializer;
        assert.ok(ts.isCallExpression(init) && init.expression.getText(source) === 'withApiLimit', path);
        assert.equal(init.arguments[0].text, '/'+path.replaceAll('\\','/').replace(/^app\//,'').replace(/\/route.ts$/,''));
        checked++;
      }
    }
  }
  assert.ok(checked > 100, `checked ${checked} API handlers`);
});
