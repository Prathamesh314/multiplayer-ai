// Disposable database + real files/locks. Admission is explicitly enabled.
import {performance} from 'node:perf_hooks';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {memoryFixture} from '../tests/helpers/memory-fixture.mjs';
import {ownerStorageBytes,withStorageAdmission} from '../app/lib/storage/admission.ts';
import {reconcileOwnerStorage} from '../app/lib/storage/accounting.ts';
import {createRepo} from '../app/lib/session/repo.ts';
import {persistActivity} from '../app/lib/runner/activity.ts';
const f=await memoryFixture(),root=await mkdtemp(join(tmpdir(),'mp-storage-bench-'));
Object.assign(process.env,{MULTIPLAYER_AI_DATA:root,ORG_STORAGE_LIMIT_BYTES:String(1024**3),STORAGE_MIN_FREE_BYTES:'0',STORAGE_PROVIDER:'local'});
for(const key of ['STORAGE_LOCAL_DIR','STORAGE_PREFIX','STORAGE_COLD_GIT'])delete process.env[key];
async function measure(label,task){const samples=[];for(let i=0;i<5;i++){const start=performance.now();await task();samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);console.log(JSON.stringify({label,medianMs:+samples[2].toFixed(2),maxMs:+samples[4].toFixed(2)}));}
try{
  await createRepo(f.room);await createRepo(f.other);
  const owner='org:'+f.org;
  await measure('empty owner usage read',()=>ownerStorageBytes(owner));
  const bare=join(root,'repos',f.other+'.git');
  // Synthetic regular Git-storage entries isolate filesystem cardinality from
  // Git's choice to pack multiple objects into one file.
  for(let offset=0;offset<5000;offset+=100)await Promise.all(Array.from({length:100},async(_,i)=>{
    const index=offset+i,dir=join(bare,'objects',(index%256).toString(16).padStart(2,'0'));
    await mkdir(dir,{recursive:true});await writeFile(join(dir,'sample'+index),Buffer.alloc(64));
  }));
  const run=await f.first("INSERT INTO agent_runs(session_id,started_by,agent_id,base_sha,status) VALUES ($1,$2,'codex',$3,'completed') RETURNING id",[f.room,f.alice,'a'.repeat(40)]);
  await f.db.query("INSERT INTO agent_turns(id,run_id,driver_user_id,control_version,status) SELECT gen_random_uuid(),$1,$2,0,'completed' FROM generate_series(1,3000)",[run.id,f.alice]);
  await reconcileOwnerStorage(owner);
  await measure('usage read: 5000 unrelated files / 3000 historical turns',()=>ownerStorageBytes(owner));
  await measure('one-byte write to small repo in that owner',()=>withStorageAdmission(f.room,()=>writeFile(join(root,'repos',f.room+'.git','sample'),'x'),1));
  await measure('one-byte write to the 5000-file repo (includes one settlement scan)',()=>withStorageAdmission(f.other,()=>writeFile(join(bare,'sample'),'x'),1));
  const turn=await f.first('SELECT id FROM agent_turns LIMIT 1');let sequence=1;
  await persistActivity(turn.id,sequence,[{t:'out',d:'warm up'}]);
  await measure('activity upload in that owner (no directory scan)',()=>persistActivity(turn.id,++sequence,[{t:'out',d:'event '+sequence}]));
}finally{await f.close();await rm(root,{recursive:true,force:true});}
