import test from 'node:test';
import assert from 'node:assert/strict';
import { serverWorkers } from '../scripts/server-config.mjs';

test('single-process default preserves local execution and terminals', () => {
  assert.equal(serverWorkers({}), 1);
  assert.equal(serverWorkers({ WEB_CONCURRENCY: '1', MULTIPLAYER_AI_TERMINAL: '1', LOCAL_RUNNERS: '0' }), 1);
});
test('multiple processes require shared events and caller-owned runners', () => {
  const env = { WEB_CONCURRENCY: '4', REDIS_URL: 'redis://localhost', LOCAL_RUNNERS: '1', MULTIPLAYER_AI_TERMINAL: '0' };
  assert.equal(serverWorkers(env), 4);
  for (const key of ['REDIS_URL', 'LOCAL_RUNNERS', 'MULTIPLAYER_AI_TERMINAL']) {
    assert.throws(() => serverWorkers({ ...env, [key]: undefined }), /require/);
  }
  for (const value of ['', '0', '17', '1.5', 'invalid']) {
    assert.throws(() => serverWorkers({ ...env, WEB_CONCURRENCY: value }), /integer/);
  }
});
