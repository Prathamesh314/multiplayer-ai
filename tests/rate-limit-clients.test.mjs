import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerApi, RunnerHttpError, permanentRunnerFailure } from '../runner/api.ts';
import { seedSession } from '../app/lib/session/remote.ts';

test('a throttled input retries the same claim after Retry-After without duplicating text', async () => {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: init.body });
    return requests.length === 1 ? Response.json({ error: 'Slow down' }, { status: 429, headers: { 'retry-after': '0.001' } }) : Response.json({ input: { id: 'queued-instruction' } });
  };
  try {
    const api = new RunnerApi('http://test', 'fixture');
    assert.equal((await api.input('turn', { kind: 'claim', claimId: 'stable-claim' })).id, 'queued-instruction');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
  } finally { globalThis.fetch = original; }
});

test('throttling is temporary for lease renewal; revocation and ownership loss are permanent', () => {
  assert.equal(permanentRunnerFailure(new RunnerHttpError('throttled', 429)), false);
  assert.equal(permanentRunnerFailure(new RunnerHttpError('unavailable', 503)), false);
  assert.equal(permanentRunnerFailure(new RunnerHttpError('lost lease', 403)), true);
  assert.equal(permanentRunnerFailure(new Error('device revoked; re-pair')), true);
});

test('folder uploads pause and retry the exact same batch on 429', async () => {
  const original = globalThis.fetch, requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: init.body });
    return requests.length === 1 ? Response.json({ error: 'Slow down' }, { status: 429, headers: { 'retry-after': '0.001' } }) : Response.json({ skipped: [], repo: { headSha: 'a'.repeat(40) } });
  };
  try {
    const result = await seedSession('fixture', { rootName: 'example', root: { name: 'example', path: '', type: 'dir', children: [] }, git: { remotes: [] } });
    assert.equal(result.repo.headSha, 'a'.repeat(40));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
  } finally { globalThis.fetch = original; }
});
