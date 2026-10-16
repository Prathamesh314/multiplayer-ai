import test from 'node:test';
import {gunzipSync,gzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {objectGit,objectText,putBlobs,commitTree} from '../app/lib/git/objects.ts';
import {createRepo,writeSeedBatch,finishSeed} from '../app/lib/session/repo.ts';
import {barePath,workPath} from '../app/lib/session/paths.ts';
import {scanFileList} from '../app/lib/scan.ts';
import {importRoomRepo} from '../app/lib/session/remote.ts';

const encoded = (path,bytes) => ({path,data:Buffer.from(bytes).toString('base64')});
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

test('empty projects store complete Git history for backups and clones',async () => {
  const root=await mkdtemp(join(tmpdir(),'mp-empty-upload-'));
  const previous=process.env.MULTIPLAYER_AI_DATA;
  process.env.MULTIPLAYER_AI_DATA=root;
  try {
    const id='emptyfixture';
    await createRepo(id);
    const seeded=await finishSeed(id,'Empty project');
    assert.equal(await objectText(barePath(id),['ls-tree',seeded.headSha]),'');
    await objectGit(barePath(id),['fsck','--full','--strict']);
    const clone=join(root,'clone.git');
    await objectGit(root,['clone','--bare','--no-local',barePath(id),clone]);
    await objectGit(clone,['fsck','--full','--strict']);
    assert.equal(await objectText(clone,['rev-parse','HEAD']),seeded.headSha);
  } finally {
    if(previous===undefined)delete process.env.MULTIPLAYER_AI_DATA;else process.env.MULTIPLAYER_AI_DATA=previous;
    await rm(root,{recursive:true,force:true});
  }
});

test('committing an empty index persists its tree in SHA-1 and SHA-256 repositories',async () => {
  const root=await mkdtemp(join(tmpdir(),'mp-empty-tree-'));
  try {
    for(const format of ['sha1','sha256']) {
      const bare=join(root,format+'.git');
      await objectGit(root,['init','--bare','-b','main',`--object-format=${format}`,bare]);
      const index={GIT_INDEX_FILE:join(bare,'import.index')};
      await objectGit(bare,['read-tree','--empty'],undefined,index);
      const tree=await objectText(bare,['write-tree'],undefined,index);
      const sha=await commitTree(bare,tree,[],'Empty project');
      await objectGit(bare,['update-ref','refs/heads/main',sha]);
      await objectGit(bare,['fsck','--full','--strict']);
    }
  } finally {await rm(root,{recursive:true,force:true});}
});

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
  const requests=[],progress=[],wire=[];
  let failOnce=true;
  globalThis.fetch=async (url,options) => {
    // The uploader compresses when CompressionStream exists, which it does
    // under Node, so read the body the way the server does.
    const encoded=options.headers?.['content-encoding']==='gzip';
    const raw=encoded?Buffer.from(options.body):Buffer.from(options.body,'utf8');
    const body=JSON.parse(encoded?gunzipSync(raw).toString('utf8'):raw.toString('utf8'));
    if(url.endsWith('/repos'))return Response.json({repo:{id:'repo',rootName:'fixture'}});
    wire.push({encoded,bytes:raw.length,plain:JSON.stringify(body).length});
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

    // Transfer is almost all of an import's wall-clock time, so the batches
    // must actually go out compressed and actually be smaller for it.
    assert.ok(wire.every(w=>w.encoded),'every batch must be gzip encoded');
    const text=wire.filter(w=>w.plain>100_000);
    assert.ok(text.length>0,'fixture should produce at least one large batch');
    assert.ok(text.every(w=>w.bytes<w.plain),'compression must shrink the payload');
  } finally {globalThis.fetch=original;}
});

test('the server reads compressed and plain batches, and refuses a decompression bomb',async () => {
  const {readSeedBody,SeedBodyError}=await import('../app/lib/session/seed-body.ts');
  const post=(body,headers={})=>new Request('http://x/seed',{method:'POST',body,headers});

  // Older clients, and any browser without CompressionStream, still send JSON.
  assert.deepEqual(await readSeedBody(post(JSON.stringify({files:[],done:true}))),{files:[],done:true});
  assert.deepEqual(await readSeedBody(post(JSON.stringify({files:[]}),{'content-encoding':'identity'})),{files:[]});

  const payload={files:[{path:'a.txt',data:Buffer.from('hello').toString('base64')}],done:false};
  const gz=gzipSync(Buffer.from(JSON.stringify(payload)));
  assert.deepEqual(await readSeedBody(post(gz,{'content-encoding':'gzip'})),payload);

  // The gateway caps the compressed body, which a bomb slips under while
  // expanding to something that would exhaust memory here.
  const bomb=gzipSync(Buffer.alloc(200*1024*1024,0x61));
  assert.ok(bomb.length<1024*1024,'the bomb must look small on the wire');
  await assert.rejects(readSeedBody(post(bomb,{'content-encoding':'gzip'})),SeedBodyError);

  await assert.rejects(readSeedBody(post(gzipSync(Buffer.from('not json')),{'content-encoding':'gzip'})),SeedBodyError);
  await assert.rejects(readSeedBody(post('x',{'content-encoding':'br'})),SeedBodyError);
});
