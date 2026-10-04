import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,rm,readFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createBackup,restoreBackup,restoreConfiguration} from '../scripts/backup.mjs';
const exec=promisify(execFile),directory=await mkdtemp(join(tmpdir(),'mp-backup-drill-'));
const source='mp-backup-'+randomBytes(4).toString('hex'),target=source+'-restore',tampered=source+'-tamper';
const image=process.env.BACKUP_TEST_IMAGE||'multiplayer-web:rate-limit-test';
const composeFile=join(directory,'compose.yml'),envFile=join(directory,'config.env');
process.env.BACKUP_ENCRYPTION_KEY=randomBytes(32).toString('hex');
const yaml=`x-app: &app
  image: ${image}
  entrypoint: ["node"]
  command: ["-e", "setInterval(()=>{},1000)"]
  environment:
    DATABASE_URL: postgres://fixture:test-only@postgres:5432/fixture
    STORAGE_PROVIDER: local
    AGENT_WORKER: "0"
    MULTIPLAYER_AI_DATA: /app/workspaces
  volumes: ["workspace_data:/app/workspaces"]
  depends_on:
    migrate: {condition: service_completed_successfully}
services:
  migrate:
    image: ${image}
    entrypoint: ["node"]
    command: ["-e", "process.exit(0)"]
  postgres:
    image: pgvector/pgvector:0.8.6-pg18-trixie
    environment: {POSTGRES_USER: fixture, POSTGRES_PASSWORD: test-only, POSTGRES_DB: fixture}
    volumes: ["postgres-data:/var/lib/postgresql"]
    healthcheck: {test: ["CMD-SHELL", "pg_isready -U fixture -d fixture"], interval: 1s, timeout: 3s, retries: 30}
  redis:
    image: redis:7-alpine
    volumes: ["redis-data:/data"]
  web: *app
  web2: *app
  worker: *app
  gateway: *app
  mnemosyne:
    image: ${image}
    entrypoint: ["node"]
    command: ["-e", "setInterval(()=>{},1000)"]
    volumes: ["mnemosyne-data:/data"]
volumes:
  workspace_data:
  postgres-data:
  redis-data:
  mnemosyne-data:
`;
await writeFile(composeFile,yaml);await writeFile(envFile,'EXAMPLE_SECRET=fixture-secret\n',{mode:0o600});
const args=project=>['compose','--env-file',envFile,'-f',composeFile,'-p',project];
const run=async argv=>(await exec('docker',argv,{maxBuffer:8*1024*1024})).stdout.trim();
try {
  // Production removes its one-shot migration container after it succeeds.
  // Backups must resume existing services even with that dependency absent.
  await run([...args(source),'run','--rm','--no-deps','-T','migrate']);
  await run([...args(source),'up','-d','--wait','--no-deps','postgres','redis','web','web2','worker','gateway','mnemosyne']);
  await run([...args(source),'run','--rm','--no-deps','-T','-v',`${resolve('db')}:/app/db:ro`,'web','db/migrate.mjs']);
  await run([...args(source),'run','--rm','--no-deps','-T','-v',`${resolve('tests/helpers/backup-seed.mjs')}:/app/seed.mjs:ro`,'web','/app/seed.mjs']);
  await run([...args(source),'exec','-T','mnemosyne','python3','-c',"import sqlite3; c=sqlite3.connect('/data/memory.db'); c.execute('create table memories(value text)'); c.execute(\"insert into memories values ('Retained team context')\"); c.commit(); c.close()"]);
  const destination=join(directory,'backup');
  const writers=['gateway','web','web2','worker','mnemosyne'];
  const writerIds=(await run([...args(source),'ps','--status','running','--quiet',...writers])).split('\n').sort();
  await createBackup({composeFile,envFile,project:source,destination});
  assert.equal((await stat(destination)).mode&0o777,0o700);
  assert.equal(writerIds.length,writers.length);
  assert.deepEqual((await run([...args(source),'ps','--status','running','--quiet',...writers])).split('\n').sort(),writerIds,'all original writer containers resume after backup');
  assert.equal(await run([...args(source),'ps','--all','--quiet','migrate']),'','backup must not rerun the removed migration service');
  const backupBytes=await readFile(join(destination,'configuration.env.enc'));
  assert.ok(!backupBytes.includes(Buffer.from('fixture-secret')));
  const recovered=join(directory,'recovered.env');
  await restoreConfiguration({source:destination,destination:recovered});
  assert.equal(await readFile(recovered,'utf8'),await readFile(envFile,'utf8'));
  assert.equal((await stat(recovered)).mode&0o777,0o600);
  await assert.rejects(restoreConfiguration({source:destination,destination:recovered}),/EEXIST/);
  const report=await restoreBackup({composeFile,envFile,project:target,source:destination});
  assert.ok(report.tables>30);assert.equal(report.repositories,1);assert.equal(report.activityBatches,1);
  assert.ok(!(await run([...args(target),'ps','--status','running','--services'])).includes('web'),'restoration cannot auto-start the app');
  const memory=await run([...args(target),'run','--rm','--no-deps','-T','--entrypoint','python3','mnemosyne','-c',"import sqlite3; c=sqlite3.connect('/data/memory.db'); print(c.execute('pragma integrity_check').fetchone()[0]); print(c.execute('select value from memories').fetchone()[0])"]);
  assert.equal(memory,'ok\nRetained team context');
  await assert.rejects(restoreBackup({composeFile,envFile,project:source,source:destination}),/different, empty/);
  await assert.rejects(restoreBackup({composeFile,envFile,project:target,source:destination}),/already has containers/);
  const oldKey=process.env.BACKUP_ENCRYPTION_KEY;process.env.BACKUP_ENCRYPTION_KEY=randomBytes(32).toString('hex');
  await assert.rejects(restoreBackup({composeFile,envFile,project:tampered,source:destination}));process.env.BACKUP_ENCRYPTION_KEY=oldKey;
  assert.equal(await run([...args(tampered),'ps','--all','--quiet']),'');
  const file=join(destination,'workspace.tgz.enc'),bytes=await readFile(file);bytes[30]^=1;await writeFile(file,bytes);
  await assert.rejects(restoreBackup({composeFile,envFile,project:tampered,source:destination}),/checksum mismatch/);
  assert.equal(await run([...args(tampered),'ps','--all','--quiet']),'');
  console.log(`PASS: encrypted backup and isolated restore verified ${report.tables} tables, transcripts, Git refs, checkpoints, object hashes and SQLite memory; corruption/wrong keys rejected before target creation.`);
}finally{
  for(const project of [source,target,tampered])await run([...args(project),'down','--volumes','--remove-orphans']).catch(()=>{});
  await rm(directory,{recursive:true,force:true});
}
