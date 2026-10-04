import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const revision = 'a'.repeat(40), previous = 'b'.repeat(40);
const script = resolve('scripts/deploy-production.sh');
const entrypoint = resolve('scripts/deploy-ssh-entrypoint.sh');

test('restricted SSH entrypoint rejects shell commands and malformed revisions', () => {
  for (const command of ['', 'bash', 'deploy main', `deploy ${revision}; id`, `deploy ${revision}\nwhoami`]) {
    const result = spawnSync('bash', [entrypoint], { env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, encoding: 'utf8' });
    assert.equal(result.status, 64, command);
    assert.match(result.stderr, /Only deploy/);
  }
});

// Exercise the real release shell with simulated external Docker/HTTP effects.
// This checks ordering, version pinning, migration guards, and recovery paths
// without touching a developer's containers, credentials, or database.
function release(scenario) {
  const root = mkdtempSync(join(tmpdir(), 'production-deploy-'));
  const state = join(root, 'state'), backups = join(root, 'backups'), bin = join(root, 'bin');
  for (const path of [state, backups, bin, join(root, 'scripts')]) mkdirSync(path);
  copyFileSync(script, join(root, 'scripts/deploy-production.sh'));
  writeFileSync(join(state, 'backup-key.env'), 'TEST_ONLY=1\n');
  writeFileSync(join(root, '.env.production'), 'APP_VERSION=old\nAPP_DOMAIN=example.com\n');
  writeFileSync(join(bin, 'fake'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const tool=path.basename(process.argv[1]),args=process.argv.slice(2),root=process.env.FIXTURE_ROOT;
fs.appendFileSync(path.join(root,'commands'),JSON.stringify({tool,args,version:process.env.APP_VERSION})+'\\n');
const scenario=process.env.SCENARIO;
if(tool==='git' && args[0]==='rev-parse')console.log('${revision}');
if(tool==='df')console.log('Filesystem 1024-blocks Used Available Capacity Mounted\\nfixture 99999999 0 99999999 0% /');
if(tool==='curl' && scenario==='health-failure')process.exit(22);
if(tool==='docker') {
  if(args[0]==='inspect')console.log(args.at(-1)==='worker-id'?'multiplayer-worker:old':'multiplayer-web:${revision}');
  if(args[0]==='run') {
    const output=args[args.indexOf('--output')+1];
    fs.mkdirSync(output);fs.writeFileSync(path.join(output,'manifest.json'),'{}');
    if(scenario==='backup-failure')process.exit(1);
  }
  if(args[0]==='compose') {
    if(args.includes('ps') && args.includes('-q'))console.log(args.at(-1)+'-id');
    if(args.includes('build') && scenario==='build-failure')process.exit(1);
    if(args.includes('exec') && args.includes('postgres')) {
      if(args.at(-1).includes('schema_migrations'))console.log(fs.existsSync(path.join(root,'migrated'))?'changed':'original');
      else console.log(scenario==='busy'?'1':'0');
    }
    if(args.includes('run') && args.at(-1)==='migrate') {
      if(scenario==='schema-change')fs.writeFileSync(path.join(root,'migrated'),'1');
      if(['migration-failure','schema-change'].includes(scenario))process.exit(1);
    }
  }
}
`, { mode: 0o755 });
  for (const tool of ['git', 'docker', 'curl', 'df']) symlinkSync(join(bin, 'fake'), join(bin, tool));
  try {
    const result = spawnSync('bash', [join(root, 'scripts/deploy-production.sh'), revision, previous], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_STATE_DIR: state, DEPLOY_BACKUP_DIR: backups, FIXTURE_ROOT: root, SCENARIO: scenario },
    });
    const commands = readFileSync(join(root, 'commands'), 'utf8').trim().split('\n').map(JSON.parse);
    return { ...result, commands, env: readFileSync(join(root, '.env.production'), 'utf8') };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('production release builds pinned images, backs up, migrates once, then checks running services', () => {
  const result = release('success');
  assert.equal(result.status, 0, result.stderr);
  const { commands } = result;
  const find = predicate => commands.findIndex(predicate);
  const build = find(c => c.args.includes('build'));
  const backup = find(c => c.args.includes('scripts/backup.mjs'));
  const migrate = find(c => c.args.includes('run') && c.args.at(-1) === 'migrate');
  const startup = find(c => c.args.includes('up'));
  assert.ok(build < backup && backup < migrate && migrate < startup);
  assert.equal(commands[build].version, revision);
  assert.equal(commands.filter(c => c.args.includes('run') && c.args.at(-1) === 'migrate').length, 1);
  assert.deepEqual(commands[startup].args.slice(-4), ['web', 'web2', 'worker', 'gateway']);
  assert.ok(commands[startup].args.includes('--no-deps'));
  assert.equal(commands.filter(c => c.tool === 'curl').length, 3);
  assert.match(result.env, new RegExp(`APP_VERSION=${revision}`));
});

for (const scenario of ['build-failure', 'busy', 'backup-failure', 'migration-failure', 'health-failure']) {
  test(`${scenario} restores previous code and configuration without deleting data`, () => {
    const result = release(scenario);
    assert.notEqual(result.status, 0);
    assert.match(result.env, /APP_VERSION=old/);
    assert.ok(result.commands.some(c => c.tool === 'git' && c.args.join(' ') === `checkout --detach ${previous}`));
    assert.equal(result.commands.some(c => c.args.includes('down')), false);
    if (['build-failure', 'busy'].includes(scenario)) {
      assert.equal(result.commands.some(c => c.args.includes('stop')), false);
    } else assert.ok(result.commands.some(c => c.args.includes('up')));
  });
}

test('partially applied migrations refuse automatic rollback to incompatible old code', () => {
  const result = release('schema-change');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Schema changed/);
  assert.equal(result.commands.some(c => c.args.includes('checkout')), false);
  assert.equal(result.commands.some(c => c.args.includes('up')), false);
  assert.deepEqual(result.commands.at(-1).args.slice(-4), ['gateway', 'web', 'web2', 'worker']);
});

test('deployment shell files parse without executing production actions', () => {
  execFileSync('bash', ['-n', script]);
  execFileSync('bash', ['-n', entrypoint]);
});
