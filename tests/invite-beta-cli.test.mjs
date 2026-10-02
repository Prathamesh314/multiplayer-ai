import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const root=fileURLToPath(new URL('../',import.meta.url));
function invoke(args) {
  const result=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/invite-beta.ts',...args],{
    cwd:root,encoding:'utf8',timeout:15_000,
    env:{...process.env,DATABASE_URL:'postgres://unused:unused@127.0.0.1:1/unused'},
  });
  assert.ifError(result.error);
  assert.equal(result.status,1);
  assert.doesNotMatch(result.stderr,/TransformError|Top-level await|ECONNREFUSED/);
  assert.doesNotMatch(result.stdout,/invite=/);
  return result.stderr;
}

test('beta invitation CLI starts through tsx and reports missing arguments without opening the database',()=>{
  assert.match(invoke([]),/Usage: npm run beta:invite/);
});

test('beta invitation CLI rejects unsafe origins before connecting to the database',()=>{
  for(const origin of ['http://workspace.example.test','https://workspace.example.test/path','https://workspace.example.test?next=other']) {
    assert.match(invoke(['owner@example.test',origin]),/Use your workspace HTTPS origin/);
  }
});
