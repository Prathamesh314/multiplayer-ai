import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdtemp,readdir,rm,stat} from 'node:fs/promises';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createGunzip} from 'node:zlib';
import pg from 'pg';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
const hash=async(stream,max=Infinity)=>{const h=createHash('sha256');let bytes=0;for await(const chunk of stream){bytes+=chunk.length;if(bytes>max)throw new Error('Stored object exceeds its size limit.');h.update(chunk);}return h.digest('hex');};
const git=async(path,args)=>(await exec('git',['-c','core.hooksPath=/dev/null','--git-dir',path,...args],{maxBuffer:16*1024*1024,timeout:120000})).stdout.trim();

/** Read-only integrity inventory. Cold bundles are hydrated only into /tmp. */
export async function verifyRestoredState() {
  if(process.env.STORAGE_PROVIDER && process.env.STORAGE_PROVIDER!=='local')throw new Error('Restore verification requires the local object store.');
  const root=resolve(process.env.MULTIPLAYER_AI_DATA||'.multiplayer-ai');
  const objects=resolve(process.env.STORAGE_LOCAL_DIR||join(root,'objects'),process.env.STORAGE_PREFIX||'');
  const objectPath=key=>{const path=resolve(objects,key);if(relative(objects,path).startsWith('..'))throw new Error('Unsafe object key.');return path;};
  const db=new pg.Client({connectionString:process.env.DATABASE_URL});
  const scratch=await mkdtemp(join(tmpdir(),'mp-restore-verify-'));
  await db.connect();
  try {
    const tables=(await db.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows;
    const database={};
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await db.query(`SET LOCAL timezone='UTC'`);
    for(const {tablename} of tables) {
      const quoted='"'+tablename.replaceAll('"','""')+'"';
      await db.query(`DECLARE inventory NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM ${quoted} t ORDER BY row_to_json(t)::text COLLATE "C"`);
      const digest=createHash('sha256');let count=0;
      for(;;){const {rows}=await db.query('FETCH 500 FROM inventory');if(!rows.length)break;for(const row of rows){digest.update(row.row+'\n');count++;}}
      await db.query('CLOSE inventory');database[tablename]={count,sha256:digest.digest('hex')};
    }
    await db.query('COMMIT');
    const archives=(await db.query('SELECT * FROM git_archives ORDER BY repository_key')).rows;
    const paths=new Map(),refs={};
    for(const folder of ['repos','projects'])for(const entry of await readdir(join(root,folder),{withFileTypes:true}).catch(()=>[])) {
      if(entry.isDirectory()&&entry.name.endsWith('.git'))paths.set(`${folder}/${entry.name}`,join(root,folder,entry.name));
    }
    for(const archive of archives) {
      const path=objectPath(archive.object_key);
      if(await hash(createReadStream(path))!==archive.content_hash)throw new Error('Git archive checksum mismatch.');
      if(!paths.has(archive.repository_key)) {
        const target=join(scratch,createHash('sha256').update(archive.repository_key).digest('hex')+'.git');
        await exec('git',['clone','--mirror',path,target],{timeout:120000});paths.set(archive.repository_key,target);
      }
    }
    for(const [key,path] of [...paths.entries()].sort(([a],[b])=>a.localeCompare(b))) {
      await git(path,['fsck','--full']);
      refs[key]=await git(path,['for-each-ref','--sort=refname','--format=%(refname) %(objectname)']);
    }
    const commits=(await db.query(`SELECT 'repos/'||session_id||'.git' AS repository,head_sha AS sha FROM session_repos
      UNION SELECT 'repos/'||id||'.git',head_sha FROM room_repos WHERE head_sha IS NOT NULL
      UNION SELECT 'repos/'||repo_ref||'.git',unnest(ARRAY[base_sha,head_sha,index_sha,snapshot_sha]) FROM workspace_snapshots`)).rows;
    for(const row of commits) {
      const path=paths.get(row.repository);if(!path||!/^[a-f0-9]{40,64}$/.test(row.sha))throw new Error('A database checkpoint is missing its repository.');
      await git(path,['cat-file','-e',row.sha]);
    }
    let activity=0;
    for(const row of (await db.query('SELECT object_key,content_hash FROM run_activity_batches ORDER BY turn_id,sequence')).rows) {
      const compressed=createReadStream(objectPath(row.object_key));
      const raw=compressed.pipe(createGunzip());compressed.on('error',error=>raw.destroy(error));
      if(await hash(raw,256*1024)!==row.content_hash)throw new Error('Activity object checksum mismatch.');activity++;
    }
    const objectFiles={};
    async function visit(path) {
      for(const entry of await readdir(path,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})) {
        const file=join(path,entry.name);
        if(entry.isDirectory())await visit(file);
        else if(entry.isFile())objectFiles[relative(objects,file)]={bytes:(await stat(file)).size,sha256:await hash(createReadStream(file))};
        else throw new Error('Object storage contains an unsupported symbolic link.');
      }
    }
    await visit(objects);
    return {database,refs,activity,objects:objectFiles};
  } finally {await db.end();await rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{console.log(JSON.stringify(await verifyRestoredState()));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
