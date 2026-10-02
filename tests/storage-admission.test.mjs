import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {withStorageAdmission,ownerStorageBytes,requireStorageGrowth} from '../app/lib/storage/admission.ts';
import {createRepo,writeSeedBatch} from '../app/lib/session/repo.ts';
const MiB=1024*1024;
test('storage admission counts all rooms, serializes competing writers and protects free disk',async t=>{
  const f=await memoryFixture(),root=await mkdtemp(join(tmpdir(),'mp-storage-limit-'));
  process.env.MULTIPLAYER_AI_DATA=root;process.env.ORG_STORAGE_LIMIT_BYTES=String(64*MiB);process.env.STORAGE_MIN_FREE_BYTES='0';
  delete process.env.STORAGE_COLD_GIT;
  const path=join(root,'repos',f.room+'.git');
  try {
    await createRepo(f.room);
    await t.test('rejected upload writes no new Git objects or index',async()=>{
      const before=await ownerStorageBytes('org:'+f.org);
      const files=Array.from({length:10},(_,i)=>({path:`file-${i}.dat`,data:Buffer.alloc(4*MiB).toString('base64')}));
      await assert.rejects(writeSeedBatch(f.room,files),/allowance is full/);
      assert.equal(await ownerStorageBytes('org:'+f.org),before);
    });
    await t.test('competing rooms cannot both spend the same remaining allowance',async()=>{
      let writes=0;
      const results=await Promise.allSettled([f.room,f.other].map(ref=>withStorageAdmission(ref,async()=>{
        await new Promise(resolve=>setTimeout(resolve,30));
        await writeFile(join(path,'quota-fixture-'+writes++),Buffer.alloc(36*MiB));
      },36*MiB)));
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(writes,1);assert.ok(await ownerStorageBytes('org:'+f.org)<64*MiB);
    });
    await t.test('low free disk refuses admission before touching existing files',async()=>{
      process.env.STORAGE_MIN_FREE_BYTES=String(Number.MAX_SAFE_INTEGER);
      await assert.rejects(withStorageAdmission(f.room,async()=>assert.fail('must not execute'),0),/low on disk/);
      process.env.STORAGE_MIN_FREE_BYTES='0';
    });
    await t.test('abandoned reservations are reclaimed by proof of kernel-lock release',async()=>{
      const reservations=join(root,'storage-reservations');
      await mkdir(reservations,{recursive:true});await writeFile(join(reservations,'31.json'),JSON.stringify({bytes:Number.MAX_SAFE_INTEGER}));
      await withStorageAdmission(f.room,()=>requireStorageGrowth(100),100);
      assert.deepEqual(await readdir(reservations),[]);
    });
  } finally {
    for(const key of ['MULTIPLAYER_AI_DATA','ORG_STORAGE_LIMIT_BYTES','STORAGE_MIN_FREE_BYTES'])delete process.env[key];
    await f.close();await rm(root,{recursive:true,force:true});
  }
});
