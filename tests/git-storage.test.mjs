import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {gitStorageConfig,repoKey,withStorageConfig} from '../app/lib/git-storage/config.ts';
import {GitStorageService} from '../app/lib/git-storage/service.ts';
import {LocalObjectStore} from '../app/lib/git-storage/objects.ts';
import * as repo from '../app/lib/session/repo.ts';
import {barePath,workPath} from '../app/lib/session/paths.ts';
import {requestSessionDeletion,restoreSession,sweep} from '../app/lib/session/retention.ts';
import {gitHttpRpc} from '../app/lib/git-storage/http.ts';

process.env.APP_ENV='testing';
const root=await mkdtemp(join(tmpdir(),'git-storage-test-'));
process.env.MULTIPLAYER_AI_DATA=join(root,'local');
const f=await memoryFixture();
let passed=0;
const test=async(name,fn)=>{await fn();passed++;console.log(`  ok ${name}`);};
const objectFiles=new LocalObjectStore(join(root,'objects'));
let failUpload=false,expireLease=false,corruptDownload=false;
const objects={
  async putFile(key,file){
    if(failUpload) throw new Error('injected upload failure');
    await objectFiles.putFile(key,file);
    if(expireLease) await f.db.query(`UPDATE git_repositories SET lease_until=now()-interval '1 second' WHERE lease_token IS NOT NULL`);
  },
  async getFile(key,file){await objectFiles.getFile(key,file);if(corruptDownload) await writeFile(file,'corrupted');},
};
const config={mode:'cloud',cacheRoot:join(root,'node-a'),bucket:'test',prefix:'git',region:'us-east-1',forcePathStyle:false};
const a=new GitStorageService(config,objects);
const b=new GitStorageService({...config,cacheRoot:join(root,'node-b')},objects);
const key=repoKey(f.room),projectKey=repoKey(f.project,true);
const author={name:'Alice',email:'alice@example.test'};
const state=()=>f.first(`SELECT * FROM git_repositories WHERE repo_key=$1`,[key]);
let initial;
try {
  await test('backend selection reads runtime environment and fails closed outside testing',async()=>{
    assert.equal(gitStorageConfig().mode,'local');
    process.env.APP_ENV='production';delete process.env.GIT_S3_BUCKET;
    assert.throws(()=>gitStorageConfig(),/GIT_S3_BUCKET/);
    process.env.GIT_S3_BUCKET='test';assert.equal(gitStorageConfig().mode,'cloud');
    const firstCache=gitStorageConfig().cacheRoot;
    process.env.GIT_S3_BUCKET='other';assert.notEqual(gitStorageConfig().cacheRoot,firstCache);
    process.env.APP_ENV='development';process.env.GIT_STORAGE_PHASE='shadow';assert.equal(gitStorageConfig().mode,'shadow');
    process.env.APP_ENV='testing';delete process.env.GIT_STORAGE_PHASE;delete process.env.GIT_S3_BUCKET;
    await withStorageConfig(config,async()=>{process.env.APP_ENV='production';assert.equal(gitStorageConfig().cacheRoot,config.cacheRoot);});
    process.env.APP_ENV='testing';
  });
  await test('project creation and room forks publish immutable bundles and refs',async()=>{
    initial=await a.withRepositories([key,projectKey],true,()=>repo.forkRoomFromProject(f.room,f.project,'example'));
    const row=await state();assert.equal(row.refs[`refs/heads/session/${f.room}`],initial.headSha);assert.ok(row.bundle_key);
  });
  await test('cloud reads refuse to replace legacy confirmed history before backfill',async()=>{
    await f.db.query(`INSERT INTO session_repos(session_id,root_name,base_branch,base_sha_at_fork,session_branch,head_sha)
      VALUES ($1,'legacy','main',$2,$3,$2)`,[f.secret,'a'.repeat(40),`session/${f.secret}`]);
    await assert.rejects(a.withRepositories([repoKey(f.secret)],true,()=>repo.createRepo(f.secret)),/shadow backfill/);
    assert.equal((await f.first(`SELECT initialized FROM git_repositories WHERE repo_key=$1`,[repoKey(f.secret)])).initialized,false);
  });
  await test('a fresh node restores all code and refs without shared disk',async()=>{
    await a.withRepositories([key],true,()=>repo.mergeSave(f.room,'hello.txt','','hello',initial.headSha,author));
    await rm(config.cacheRoot,{recursive:true,force:true});
    const head=await b.withRepositories([key],false,()=>repo.repoRefHeadSha(f.room));
    assert.equal(await b.withRepositories([key],false,()=>repo.readRepoRefFileText(f.room,'hello.txt')),'hello');
    assert.notEqual(head,initial.headSha);
  });
  await test('concurrent writers on independent caches preserve both edits',async()=>{
    await Promise.all([
      a.withRepositories([key],true,()=>repo.mergeSave(f.room,'one.txt','','one',initial.headSha,author)),
      b.withRepositories([key],true,()=>repo.mergeSave(f.room,'two.txt','','two',initial.headSha,author)),
    ]);
    const files=await a.withRepositories([key],false,()=>repo.listRepoRefFiles(f.room));
    assert.ok(files.includes('one.txt'));assert.ok(files.includes('two.txt'));
  });
  await test('upload failure cannot advance refs or invoke the database head callback',async()=>{
    const before=await state();let callback=false;failUpload=true;
    await assert.rejects(a.withRepositories([key],true,()=>repo.mergeSave(f.room,'hello.txt','hello','lost',initial.headSha,author,async()=>{callback=true;})),/upload failure/);
    failUpload=false;assert.equal(callback,false);assert.equal((await state()).revision,before.revision);
    assert.equal(await a.withRepositories([key],false,()=>repo.readRepoRefFileText(f.room,'hello.txt')),'hello');
  });
  await test('expired writer cannot publish refs after its object upload succeeds',async()=>{
    const before=await state();expireLease=true;
    await assert.rejects(a.withRepositories([key],true,()=>repo.mergeSave(f.room,'hello.txt','hello','stale',initial.headSha,author)),/lease expired/);
    expireLease=false;assert.equal((await state()).revision,before.revision);
    assert.equal(await b.withRepositories([key],false,()=>repo.readRepoRefFileText(f.room,'hello.txt')),'hello');
  });
  await test('an expired no-change save cannot update application metadata',async()=>{
    let acknowledged=false;
    await assert.rejects(a.withRepositories([key],false,async()=>{
      await f.db.query(`UPDATE git_repositories SET lease_until=now()-interval '1 second' WHERE repo_key=$1`,[key]);
      await repo.mergeSave(f.room,'hello.txt','hello','hello',initial.headSha,author,async()=>{acknowledged=true;});
    }),/lease expired/);
    assert.equal(acknowledged,false);
  });
  await test('checksum mismatch refuses a cold restore instead of serving partial code',async()=>{
    const c=new GitStorageService({...config,cacheRoot:join(root,'node-c')},objects);corruptDownload=true;
    await assert.rejects(c.withRepositories([key],false,()=>repo.repoRefHeadSha(f.room)),/checksum/);
    corruptDownload=false;
    assert.ok(await c.withRepositories([key],false,()=>repo.repoRefHeadSha(f.room)));
  });
  await test('folder-upload batches survive cache loss before final seeding',async()=>{
    const imported=repoKey(f.other);
    await a.withRepositories([imported],true,()=>repo.createRepo(f.other));
    await a.withRepositories([imported],true,()=>repo.writeSeedBatch(f.other,[{path:'first.txt',data:Buffer.from('first').toString('base64')}]));
    await b.withRepositories([imported],true,()=>repo.writeSeedBatch(f.other,[{path:'second.txt',data:Buffer.from('second').toString('base64')}]));
    await a.withRepositories([imported],true,()=>repo.finishSeed(f.other,'import'));
    const files=await b.withRepositories([imported],false,()=>repo.listRepoRefFiles(f.other));
    assert.deepEqual(files.sort(),['first.txt','second.txt']);
  });
  await test('publication atomically updates room and canonical project snapshots',async()=>{
    const result=await a.withRepositories([key,projectKey],true,()=>repo.publishRoom(f.room,f.project));
    assert.equal(result.ok,true);
    const rows=(await f.db.query(`SELECT * FROM git_repositories WHERE repo_key=ANY($1::text[])`,[[key,projectKey]])).rows;
    assert.equal(rows.find(x=>x.repo_key===projectKey).refs['refs/heads/main'],result.sha);
    assert.equal(rows.find(x=>x.repo_key===key).refs[`refs/heads/session/${f.room}`],result.sha);
  });
  await test('Git HTTP advertisement hydrates cold repos and uses the stored refs',async()=>{
    await rm(b.config.cacheRoot,{recursive:true,force:true});
    const body=await b.withRepositories([key],false,()=>gitHttpRpc(f.room,b.bare(key),['upload-pack','--stateless-rpc','--advertise-refs',b.bare(key)],{prefix:'header\n'}));
    const output=await new Response(body).text();assert.ok(output.startsWith('header\n'));assert.ok(output.includes(`refs/heads/session/${f.room}`));
  });
  await test('receive-pack acknowledges a candidate only after durable publication',async()=>{
    const push=async(ref)=>a.withRepositories([key],false,async()=>{
      const sha=(await state()).refs[`refs/heads/session/${f.room}`];
      const packing=promisify(execFile)('git',['pack-objects','--stdout','--all'],{cwd:a.bare(key),encoding:'buffer',timeout:10_000});
      packing.child.stdin.end();
      const {stdout:pack}=await packing;
      const command=Buffer.from(`${'0'.repeat(40)} ${sha} ${ref}\0report-status\n`);
      const input=Buffer.concat([Buffer.from((command.length+4).toString(16).padStart(4,'0')),command,Buffer.from('0000'),pack]);
      return gitHttpRpc(f.room,a.bare(key),['receive-pack','--stateless-rpc',a.bare(key)],{stdin:Readable.from([input]),write:true});
    });
    const ref=`refs/turns/${randomUUID()}`;
    const body=await push(ref);
    assert.ok((await new Response(body).text()).includes(`ok ${ref}`));
    assert.ok((await state()).refs[ref]);
    const rejected=`refs/turns/${randomUUID()}`;
    failUpload=true;
    try {await assert.rejects(push(rejected),/upload failure/);} finally {failUpload=false;}
    assert.equal((await state()).refs[rejected],undefined);
    await b.withRepositories([key],false,async()=>{
      const {stdout}=await promisify(execFile)('git',['for-each-ref','--format=%(refname)'],{cwd:b.bare(key)});
      assert.ok(stdout.includes(ref));assert.ok(!stdout.includes(rejected));
    });
  });
  await test('cloud deletion preserves durable snapshots and rejects subsequent Git access',async()=>{
    await a.withRepositories([key],false,()=>requestSessionDeletion(f.room,f.alice,f.room));
    await assert.rejects(b.withRepositories([key],false,()=>repo.repoRefHeadSha(f.room)),/deleted room/);
    // Operator migration must preserve deleted rooms' restorable code too.
    await b.withRepositories([key],false,async()=>assert.ok(await stat(b.bare(key))),{maintenance:true});
    assert.ok((await state()).bundle_key);
    await restoreSession(f.room,f.alice);
    assert.equal(await b.withRepositories([key],false,()=>repo.readRepoRefFileText(f.room,'hello.txt')),'hello');
  });
} finally {await f.close();}

const local=await memoryFixture();
try {
  const id=local.room;
  await repo.createRepo(id);await repo.writeSeedBatch(id,[{path:'keep.txt',data:Buffer.from('keep forever').toString('base64')}]);
  const seeded=await repo.finishSeed(id,'retention');
  await test('inactivity archives with a bundle and never deletes confirmed code',async()=>{
    await local.db.query(`UPDATE sessions SET last_active_at=now()-interval '60 days' WHERE id=$1`,[id]);
    const result=await sweep();assert.ok(result.archived.includes(id));assert.deepEqual(result.deleted,[]);
    assert.ok(await stat(barePath(id)));assert.equal(await stat(workPath(id)).then(()=>true,()=>false),false);
    assert.ok((await local.first(`SELECT backup FROM session_archives WHERE session_id=$1`,[id])).backup.repositories[0].bundle);
  });
  await test('deletion requires org admin, exact name, and seven-day restorable grace',async()=>{
    await assert.rejects(requestSessionDeletion(id,local.bob,id),/admin/);
    await assert.rejects(requestSessionDeletion(id,local.alice,'wrong'),/exact room name/);
    const deletion=await requestSessionDeletion(id,local.alice,id);
    assert.ok(new Date(deletion.delete_after)-new Date(deletion.requested_at)>=7*86400000);
    assert.deepEqual((await sweep()).deleted,[]);
    await restoreSession(id,local.alice);
    assert.equal((await local.first(`SELECT deleted_at FROM sessions WHERE id=$1`,[id])).deleted_at,null);
  });
  await test('completed deletion removes caches but bundle restores the original room and code',async()=>{
    await requestSessionDeletion(id,local.alice,id);
    await local.db.query(`UPDATE session_deletions SET requested_at=now()-interval '8 days',delete_after=now()-interval '1 day' WHERE session_id=$1`,[id]);
    assert.ok((await sweep()).deleted.includes(id));assert.equal(await stat(barePath(id)).then(()=>true,()=>false),false);
    await restoreSession(id,local.alice);
    assert.equal((await repo.readCommittedBytes(id,seeded.headSha,'keep.txt')).toString(),'keep forever');
    assert.ok(await local.first(`SELECT id FROM sessions WHERE id=$1`,[id]));
  });
} finally {await local.close();await rm(root,{recursive:true,force:true});}
console.log(`${passed} Git storage and retention tests passed`);
