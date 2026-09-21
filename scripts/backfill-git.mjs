import nextEnv from '@next/env';
import {readdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {gitStorageConfig,repoKey} from '../app/lib/git-storage/config.ts';
import {GitStorageService,storageGit} from '../app/lib/git-storage/service.ts';
import {s3ObjectStore} from '../app/lib/git-storage/objects.ts';
import {query,pool} from '../app/lib/db/client.ts';

nextEnv.loadEnvConfig(process.cwd(),process.env.NODE_ENV!=='production');
const config=gitStorageConfig();
if(config.mode!=='shadow') throw new Error('Set GIT_STORAGE_PHASE=shadow on the host with the legacy repositories before backfill or verification.');
const root=resolve(process.env.MULTIPLAYER_AI_DATA||'.multiplayer-ai');
const keys=[];
for(const directory of ['repos','projects']) {
  let entries;
  try {entries=await readdir(join(root,directory),{withFileTypes:true});}
  catch(cause) {if(cause.code==='ENOENT') continue;throw cause;}
  for(const entry of entries) if(entry.isDirectory()&&entry.name.endsWith('.git')) keys.push(repoKey(entry.name.slice(0,-4),directory==='projects'));
}
try {
  if(process.argv.includes('--verify')) {
    const cacheRoot=await mkdtemp(join(tmpdir(),'git-verify-'));
    const verifier=new GitStorageService({...config,mode:'cloud',cacheRoot},await s3ObjectStore(config));
    try {
      for(const key of keys) await verifier.withRepositories([key],false,async()=>{
        const [source,restored]=await Promise.all([join(root,`${key}.git`),verifier.bare(key)].map(path=>storageGit(path,['for-each-ref','--format=%(refname) %(objectname)'])));
        if(source!==restored) throw new Error(`Ref mismatch for ${key}; requeue and wait for backfill before switching reads.`);
      },{maintenance:true});
      console.log(`Verified ${keys.length} repositories by downloading their cloud bundles and comparing every ref.`);
    } finally {await rm(cacheRoot,{recursive:true,force:true});}
  } else {
    for(const key of keys) await query(`INSERT INTO git_storage_jobs(repo_key) VALUES ($1)
      ON CONFLICT(repo_key) DO UPDATE SET retry_at=now(),last_error=NULL`,[key]);
    console.log(`Queued ${keys.length} repositories. Run the shadow-mode worker, then npm run storage:verify before switching reads.`);
  }
} finally {await pool().end();}
