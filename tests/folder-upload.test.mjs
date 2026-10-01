import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {objectGit,objectText,putBlobs} from '../app/lib/git/objects.ts';
import {createRepo,writeSeedBatch,finishSeed} from '../app/lib/session/repo.ts';
import {barePath,workPath} from '../app/lib/session/paths.ts';
import {scanFileList} from '../app/lib/scan.ts';
import {importRoomRepo} from '../app/lib/session/remote.ts';

const encoded = (path,bytes) => ({path,data:Buffer.from(bytes).toString('base64')});
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

test('10,000-file import preserves every blob, retries, ignores and bare-only storage',async () => {
  const root=await mkdtemp(join(tmpdir(),'mp-upload-test-'));
  const previous=process.env.MULTIPLAYER_AI_DATA;
  process.env.MULTIPLAYER_AI_DATA=root;
  try {
    const id='uploadfixture';
    await createRepo(id);
    const files=Array.from({length:10000},(_,i)=>encoded(`src/group${i%30}/file${i}.ts`,`export const n = ${i};\n`));
    const special=[encoded('assets/binary.dat',Buffer.from([0,255,13,10,0,128])),encoded('empty.txt',''),
      encoded('nested/ünicode\tfile\nname.txt','blob\nmark :999\ndata 5\nhello\ndone\n'),
      encoded('README.md','original'),encoded('ignored.log','ignored'),encoded('nested/private.txt','ignored'),
      encoded('nested/keep.txt','kept')];
    files.push(...special);
    const started=performance.now();
    for(let offset=0;offset<files.length;offset+=200) {
      const batch=files.slice(offset,offset+200);
      assert.deepEqual(await writeSeedBatch(id,batch),{written:batch.length,skipped:[]});
    }
    const bare=barePath(id), index={GIT_INDEX_FILE:join(bare,'import.index')};
    const before=await objectText(bare,['write-tree'],undefined,index);
    await writeSeedBatch(id,files.slice(0,200));
    assert.equal(await objectText(bare,['write-tree'],undefined,index),before,'retry is idempotent');
    const rejected=[encoded('../escape','no'),encoded('.git/hooks/pre-commit','no'),encoded('.env','secret'),
      encoded('node_modules/foo.js','no'),encoded('large.bin',Buffer.alloc(8*1024*1024+1))];
    assert.deepEqual(await writeSeedBatch(id,rejected),{written:0,skipped:rejected.map(f=>f.path)});
    const last=[encoded('.gitignore','*.log\n'),encoded('nested/.gitignore','private.txt\n'),encoded('README.md','updated')];
    await writeSeedBatch(id,last);
    const seeded=await finishSeed(id,'Large folder');
    const expected=new Map([...files,...last].map(f=>[f.path,blobHash(Buffer.from(f.data,'base64'))]));
    expected.delete('ignored.log');expected.delete('nested/private.txt');
    const entries=(await objectText(bare,['ls-tree','-r','-z',seeded.headSha])).split('\0').filter(Boolean);
    assert.equal(entries.length,expected.size);
    for(const entry of entries) {
      const tab=entry.indexOf('\t'), path=entry.slice(tab+1), sha=entry.slice(0,tab).split(' ')[2];
      assert.equal(sha,expected.get(path),path);
    }
    await objectGit(bare,['fsck','--strict','--no-dangling']);
    await assert.rejects(access(workPath(id)),{code:'ENOENT'});
    await assert.rejects(access(index.GIT_INDEX_FILE),{code:'ENOENT'});
    console.log(`10,000-file import including verification: ${Math.round(performance.now()-started)} ms`);
  } finally {
    if(previous===undefined)delete process.env.MULTIPLAYER_AI_DATA;else process.env.MULTIPLAYER_AI_DATA=previous;
    await rm(root,{recursive:true,force:true});
  }
});

test('index contention leaves existing files intact and a retry succeeds (SHA-1 and SHA-256)',async () => {
  const root=await mkdtemp(join(tmpdir(),'mp-upload-lock-'));
  try {
    for(const format of ['sha1','sha256']) {
      const bare=join(root,format+'.git');
      await objectGit(root,['init','--bare',`--object-format=${format}`,bare]);
      const index={GIT_INDEX_FILE:join(bare,'import.index')};
      await objectGit(bare,['read-tree','--empty'],undefined,index);
      await putBlobs(bare,index,[{path:'old.txt',bytes:Buffer.from('old')}]);
      const before=await readFile(index.GIT_INDEX_FILE);
      await writeFile(index.GIT_INDEX_FILE+'.lock','test lock');
      const files=[{path:'new.txt',bytes:Buffer.from('new')}];
      await assert.rejects(putBlobs(bare,index,files),/lock/);
      assert.deepEqual(await readFile(index.GIT_INDEX_FILE),before);
      await rm(index.GIT_INDEX_FILE+'.lock');
      await putBlobs(bare,index,files);
      assert.equal(await objectText(bare,['show',':old.txt'],undefined,index),'old');
      assert.equal(await objectText(bare,['show',':new.txt'],undefined,index),'new');
      await putBlobs(bare,index,[]);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

test('browser uploader batches files, retries unchanged data, bounds payloads and reports finalization',async () => {
  const original=globalThis.fetch;
  const requests=[],progress=[];
  let failOnce=true;
  globalThis.fetch=async (url,options) => {
    const body=JSON.parse(options.body);
    if(url.endsWith('/repos'))return Response.json({repo:{id:'repo',rootName:'fixture'}});
    requests.push(body);
    if(failOnce){failOnce=false;return Response.json({error:'temporary'},{status:503});}
    return Response.json({skipped:[],headSha:body.done?'a'.repeat(40):null});
  };
  try {
    const files=Array.from({length:401},(_,i)=>new File([`file ${i}`],`file${i}.txt`));
    files.push(new File([new Uint8Array(4*1024*1024)],'large-a.bin'),new File([new Uint8Array(4*1024*1024)],'large-b.bin'));
    const result=await scanFileList(files,'input');
    const imported=await importRoomRepo('room',result,p=>progress.push(p));
    assert.equal(imported.repo.headSha,'a'.repeat(40));
    assert.deepEqual(requests[0],requests[1],'network retries must resend the exact batch');
    const accepted=requests.slice(1);
    assert.equal(accepted.flatMap(r=>r.files).length,files.length);
    assert.equal(new Set(accepted.flatMap(r=>r.files.map(f=>f.path))).size,files.length);
    for(const request of accepted) {
      assert.ok(request.files.length<=200);
      assert.ok(request.files.reduce((sum,file)=>sum+Buffer.from(file.data,'base64').length,0)<=6*1024*1024);
    }
    assert.equal(accepted.at(-1).done,true);
    assert.deepEqual(progress[0],{uploaded:0,total:files.length,phase:'uploading'});
    assert.deepEqual(progress.at(-1),{uploaded:files.length,total:files.length,phase:'finalizing'});
  } finally {globalThis.fetch=original;}
});
