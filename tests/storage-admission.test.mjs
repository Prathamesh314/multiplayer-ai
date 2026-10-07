import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import cp,{fork} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {withStorageAdmission,ownerStorageBytes,requireStorageGrowth} from '../app/lib/storage/admission.ts';
import {directoryBytes,reconcileOwnerStorage,recoverStorageReservations} from '../app/lib/storage/accounting.ts';
import {createRepo,writeSeedBatch,finishSeed} from '../app/lib/session/repo.ts';
import {persistActivity} from '../app/lib/runner/activity.ts';
const MiB=1024*1024;
const postgres=process.env.STORAGE_TEST_POSTGRES==='1';
async function fixture(t,limit=256*MiB){
  const f=await memoryFixture({postgres}),root=await fs.mkdtemp(join(tmpdir(),'mp-storage-accounting-'));
  const config={MULTIPLAYER_AI_DATA:root,ORG_STORAGE_LIMIT_BYTES:String(limit),STORAGE_MIN_FREE_BYTES:'0',STORAGE_PROVIDER:'local',STORAGE_LOCAL_DIR:undefined,STORAGE_PREFIX:undefined,STORAGE_COLD_GIT:undefined};
  const previous=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]));
  for(const [key,value] of Object.entries(config)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  t.after(async()=>{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await f.close();await fs.rm(root,{recursive:true,force:true});});
  return {...f,root,owner:'org:'+f.org,path:ref=>join(root,'repos',ref+'.git'),usage:()=>ownerStorageBytes('org:'+f.org)};
}
async function turn(f){
  const run=await f.first("INSERT INTO agent_runs(session_id,started_by,agent_id,base_sha,status) VALUES ($1,$2,'codex',$3,'completed') RETURNING id",[f.room,f.alice,'a'.repeat(40)]);
  return f.first("INSERT INTO agent_turns(id,run_id,driver_user_id,control_version,status) VALUES (gen_random_uuid(),$1,$2,0,'completed') RETURNING id,run_id",[run.id,f.alice]);
}
async function noReservations(f){
  assert.equal(Number((await f.first('SELECT count(*) AS n FROM storage_reservations')).n),0);
  assert.equal(Number((await f.first('SELECT reserved_bytes FROM storage_capacity WHERE id=1')).reserved_bytes),0);
  assert.equal(Number((await f.first('SELECT reserved_bytes FROM storage_usage WHERE owner=$1',[f.owner])).reserved_bytes),0);
}
function failTransactionQuery(prefix,message){
  const pool=globalThis.__maPool,connect=pool.connect;let fail=true;
  pool.connect=function(...args){
    // pg.Pool.query uses callback-style connect; transaction() uses a promise.
    if(typeof args[0]==='function')return connect.apply(this,args);
    return connect.apply(this,args).then(client=>{
      const query=client.query,release=client.release;
      client.query=function(sql,...params){if(fail&&sql.startsWith(prefix)){fail=false;return Promise.reject(Error(message));}return query.call(this,sql,...params);};
      client.release=function(...args){client.query=query;client.release=release;return release.apply(this,args);};return client;
    });
  };
  return()=>{pool.connect=connect;};
}

test('concurrent repositories reserve atomically and cannot spend the same allowance',async t=>{
  const f=await fixture(t,64*MiB);await createRepo(f.room);await createRepo(f.other);
  let writes=0;
  const results=await Promise.allSettled([f.room,f.other].map(ref=>withStorageAdmission(ref,async()=>{
    await delay(50);await fs.writeFile(join(f.path(ref),'quota-fixture'),Buffer.alloc(36*MiB));writes++;
  },36*MiB)));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(writes,1);
  assert.equal(await f.usage(),await directoryBytes(f.path(f.room))+await directoryBytes(f.path(f.other)));
  await noReservations(f);
});

test('different repositories under the same owner execute concurrently',async t=>{
  const f=await fixture(t);await createRepo(f.room);await createRepo(f.other);
  let entered=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const deadline=setTimeout(release,5000);
  try{await Promise.all([f.room,f.other].map(ref=>withStorageAdmission(ref,async()=>{
    if(++entered===2)release();await gate;assert.equal(entered,2,'a whole-owner execution lock must not serialize these tasks');
  },1024)));}finally{clearTimeout(deadline);release();}
  await noReservations(f);
});

test('eight independent owners overlap without slot collisions or reservation probes',async t=>{
  const f=await fixture(t),rooms=[];
  for(let i=0;i<8;i++){
    const org=await f.first('INSERT INTO orgs(slug,name,created_by) VALUES ($1,$2,$3) RETURNING id',['storage'+i,'Storage '+i,f.alice]);
    const ref='benchmarkxx'+String.fromCharCode(97+i);
    await f.db.query("INSERT INTO sessions(id,owner_id,org_id,name,join_code) VALUES ($1,$2,$3,$1,'ABCD-EFGH')",[ref,f.alice,org.id]);
    await ownerStorageBytes('org:'+org.id);rooms.push(ref);
  }
  const spawn=cp.spawn;let helpers=0,entered=0,release;const gate=new Promise(resolve=>{release=resolve;});
  cp.spawn=(...args)=>{if(String(args[0]).includes('python'))helpers++;return spawn(...args);};syncBuiltinESMExports();
  const deadline=setTimeout(release,5000);
  try{await Promise.all(rooms.map(ref=>withStorageAdmission(ref,async()=>{
    if(++entered===8){
      if(postgres)assert.equal(Number((await f.first("SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).n),0,'tasks do not keep SQL transactions open');
      release();
    }
    await gate;assert.equal(entered,8);
  },1024)));assert.equal(helpers,8);}
  finally{clearTimeout(deadline);release();cp.spawn=spawn;syncBuiltinESMExports();}
  assert.equal(Number((await f.first('SELECT reserved_bytes FROM storage_capacity WHERE id=1')).reserved_bytes),0);
});

test('rejected imports leave Git untouched; nested growth checks do not rescan or spend twice',async t=>{
  const f=await fixture(t,64*MiB);await createRepo(f.room);const before=await f.usage();
  const files=Array.from({length:10},(_,i)=>({path:`file-${i}.dat`,data:Buffer.alloc(4*MiB).toString('base64')}));
  await assert.rejects(writeSeedBatch(f.room,files),/allowance is full/);assert.equal(await f.usage(),before);
  await withStorageAdmission(f.room,async()=>{
    await requireStorageGrowth(100);await requireStorageGrowth(100);
    await withStorageAdmission(f.room,async()=>{} ,100);
    assert.equal(Number((await f.first('SELECT reserved_bytes FROM storage_usage WHERE owner=$1',[f.owner])).reserved_bytes),100);
  },100);
  await noReservations(f);
});

test('import completion records actual packs and removes temporary index usage',async t=>{
  const f=await fixture(t);await createRepo(f.room);
  await writeSeedBatch(f.room,Array.from({length:500},(_,i)=>({path:`file${i}.txt`,data:Buffer.from('sample '+i).toString('base64')})));
  assert.equal(await f.usage(),await directoryBytes(f.path(f.room)));
  await finishSeed(f.room,'Example');
  assert.equal(await f.usage(),await directoryBytes(f.path(f.room)));
  await assert.rejects(fs.stat(join(f.path(f.room),'import.index')),error=>error.code==='ENOENT');
});

test('small writes use small disk reservations while the free-space floor is enforced',async t=>{
  const f=await fixture(t);await createRepo(f.room);
  const free=await fs.statfs(f.root);process.env.STORAGE_MIN_FREE_BYTES=String(free.bavail*free.bsize-64*MiB);
  await withStorageAdmission(f.room,async()=>{
    const reservation=await f.first('SELECT disk_bytes FROM storage_reservations');
    assert.equal(Number(reservation.disk_bytes),4096);
    await fs.writeFile(join(f.path(f.room),'tiny'),'x');
  },1);
  process.env.STORAGE_MIN_FREE_BYTES=String(Number.MAX_SAFE_INTEGER);
  await assert.rejects(withStorageAdmission(f.room,async()=>assert.fail('must not execute'),1),/low on disk/);
  await noReservations(f);
});

test('an irregular file quarantines its repository, not the rest of the organisation',async t=>{
  const f=await fixture(t);await fs.mkdir(f.path(f.other),{recursive:true});
  await fs.symlink(join(f.root,'missing'),join(f.path(f.other),'unexpected'));
  await createRepo(f.room);
  await assert.rejects(withStorageAdmission(f.other,async()=>assert.fail('quarantined resource'),1),/non-regular/);
  await withStorageAdmission(f.room,()=>fs.writeFile(join(f.path(f.room),'safe'),'ok'),2);
  await fs.unlink(join(f.path(f.other),'unexpected'));await reconcileOwnerStorage(f.owner);
  await withStorageAdmission(f.other,async()=>{},0);await noReservations(f);
});

test('activity charges compressed stored objects once, including retries and duplicate content',async t=>{
  const f=await fixture(t),item=await turn(f),events=[{t:'out',d:'sample '.repeat(1000)}];
  await persistActivity(item.id,1,events);const initial=await f.usage();
  assert.ok(initial>0&&initial<1000);
  assert.equal(await persistActivity(item.id,1,events),false);
  await persistActivity(item.id,2,events);assert.equal(await f.usage(),initial);
  assert.equal(await f.usage(),await directoryBytes(join(f.root,'objects','activity',item.id)));
  await noReservations(f);
});

test('a file surviving activity transaction rollback remains charged and retry is idempotent',async t=>{
  const f=await fixture(t),item=await turn(f),events=[{t:'out',d:'keep this activity'}];
  const restore=failTransactionQuery('INSERT INTO run_activity_batches','simulated rollback');
  try{await assert.rejects(persistActivity(item.id,1,events),/simulated rollback/);}finally{restore();}
  const before=await f.usage();assert.ok(before>0);
  assert.equal(Number((await f.first('SELECT count(*) AS n FROM run_activity_batches')).n),0);
  await persistActivity(item.id,1,events);assert.equal(await f.usage(),before);await noReservations(f);
});

test('failed accounting keeps its durable reservation until reconciliation succeeds',async t=>{
  const f=await fixture(t);await createRepo(f.room);const before=await f.usage();
  const restore=failTransactionQuery('UPDATE storage_resources SET bytes=','simulated settlement failure');
  try{await assert.rejects(withStorageAdmission(f.room,()=>fs.writeFile(join(f.path(f.room),'written-before-failure'),'abc'),3),/could not be confirmed/);}finally{restore();}
  assert.equal(Number((await f.first('SELECT count(*) AS n FROM storage_reservations')).n),1);
  assert.equal(await f.usage(),before);
  assert.deepEqual((await recoverStorageReservations()).recovered,[`repo:${f.room}`]);
  assert.equal(await f.usage(),before+3);await noReservations(f);
});

test('admission cost is independent of unrelated files and historical turns',async t=>{
  const f=await fixture(t);await fs.mkdir(f.path(f.other),{recursive:true});
  for(let offset=0;offset<5000;offset+=100)await Promise.all(Array.from({length:100},(_,i)=>fs.writeFile(join(f.path(f.other),'object'+(offset+i)),'x')));
  const item=await turn(f);
  await f.db.query("INSERT INTO agent_turns(id,run_id,driver_user_id,control_version,status) SELECT gen_random_uuid(),$1,$2,0,'completed' FROM generate_series(1,3000)",[item.run_id,f.alice]);
  await createRepo(f.room);await persistActivity(item.id,1,[{t:'out',d:'first'}]);
  const original={readdir:fs.readdir,lstat:fs.lstat,spawn:cp.spawn};let walks=0,probes=0,helpers=0;
  fs.readdir=async(...args)=>{walks++;assert.ok(!String(args[0]).includes(f.other),'must not scan another repository');return original.readdir(...args);};
  fs.lstat=async(...args)=>{probes++;assert.ok(!String(args[0]).includes(f.other),'must not stat another repository');return original.lstat(...args);};
  cp.spawn=(...args)=>{if(String(args[0]).includes('python'))helpers++;return original.spawn(...args);};syncBuiltinESMExports();
  try{
    await f.usage();assert.equal(walks,0);assert.equal(probes,0);
    await persistActivity(item.id,2,[{t:'out',d:'second'}]);assert.equal(walks,0,'normal activity accounting never walks a directory');assert.ok(probes<=3);assert.equal(helpers,1,'one resource lock, no owner/slot/probe helpers');
    await withStorageAdmission(f.room,async()=>{await requireStorageGrowth(10);await requireStorageGrowth(10);await fs.writeFile(join(f.path(f.room),'small'),'x');},10);
    assert.ok(probes<60,'only the small modified Git repository is measured');assert.equal(helpers,2);
  }finally{Object.assign(fs,{readdir:original.readdir,lstat:original.lstat});cp.spawn=original.spawn;syncBuiltinESMExports();}
  assert.equal(await f.usage(),await directoryBytes(f.path(f.room))+await directoryBytes(f.path(f.other))+await directoryBytes(join(f.root,'objects','activity',item.id)));
});

test('recovery preserves a stopped writer and a Git child after parent death',{skip:!postgres},async t=>{
  const f=await fixture(t);await createRepo(f.room);
  process.env.ORG_STORAGE_LIMIT_BYTES=String(await f.usage()+2*MiB-1);
  const start=mode=>{
    const child=fork(new URL('./helpers/storage-process.mjs',import.meta.url),[f.room,mode],{execArgv:['--import','tsx'],env:{...process.env,PGOPTIONS:globalThis.__maPool.options.options},stdio:['ignore','ignore','pipe','ipc']});
    let errors='';child.stderr.on('data',data=>{errors+=data;});t.after(()=>{if(child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');});
    return {child,errors:()=>errors};
  };
  const holder=start('hold');assert.equal((await once(holder.child,'message'))[0],'locked',holder.errors());
  await assert.rejects(withStorageAdmission(f.other,async()=>assert.fail('another process already reserved this allowance'),MiB),/allowance is full/);
  holder.child.kill('SIGSTOP');assert.deepEqual((await recoverStorageReservations()).busy,[`repo:${f.room}`]);
  const exited=once(holder.child,'exit');holder.child.kill('SIGKILL');await exited;
  assert.deepEqual((await recoverStorageReservations()).recovered,[`repo:${f.room}`]);await noReservations(f);
  process.env.ORG_STORAGE_LIMIT_BYTES=String(256*MiB);
  const writer=start('git');let started=false;
  for(let i=0;i<100;i++){if(await fs.stat(join(f.path(f.room),'git-started')).catch(()=>null)){started=true;break;}await delay(50);}
  assert.ok(started,writer.errors());const parentExit=once(writer.child,'exit');writer.child.kill('SIGKILL');await parentExit;
  assert.deepEqual((await recoverStorageReservations()).busy,[`repo:${f.room}`]);
  let recovered=false;for(let i=0;i<100;i++){if((await recoverStorageReservations()).recovered.length){recovered=true;break;}await delay(50);}
  assert.ok(recovered);assert.ok(await fs.stat(join(f.path(f.room),'git-finished')));await noReservations(f);
  assert.equal(await f.usage(),await directoryBytes(f.path(f.room)));
});
