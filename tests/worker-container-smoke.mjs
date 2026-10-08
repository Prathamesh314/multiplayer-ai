// Exercise deployment CLIs through the shipped worker's Node/tsx runtime.
// Host-side tests cannot detect all CJS/ESM interop differences in this image.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

const exec=promisify(execFile),directory=await mkdtemp(join(tmpdir(),'mp-worker-smoke-'));
const project='mp-worker-smoke-'+randomUUID().slice(0,8);
const image=process.env.TEST_WORKER_IMAGE??'multiplayer-worker:ci';
const composeFile=join(directory,'compose.json');
await writeFile(composeFile,JSON.stringify({
  services:{
    postgres:{image:'pgvector/pgvector:0.8.6-pg18-trixie',environment:{POSTGRES_USER:'fixture',POSTGRES_PASSWORD:'test-only',POSTGRES_DB:'fixture'},
      healthcheck:{test:['CMD-SHELL','pg_isready -U fixture -d fixture'],interval:'1s',timeout:'3s',retries:30}},
    worker:{image,environment:{NODE_ENV:'production',DATABASE_URL:'postgres://fixture:test-only@postgres:5432/fixture',
      STORAGE_PROVIDER:'local',MULTIPLAYER_AI_DATA:'/app/workspaces'},volumes:['workspace:/app/workspaces']},
  },volumes:{workspace:{}},
}));
const docker=async args=>(await exec('docker',args,{timeout:120_000,maxBuffer:2*1024*1024})).stdout.trim();
const compose=['compose','-p',project,'-f',composeFile];
const worker=(...args)=>docker([...compose,'run','--rm','--no-deps','-T','worker',...args]);
const accounting=mode=>worker('node','--import','tsx','scripts/storage-accounting.ts',mode);
try {
  await docker([...compose,'up','-d','--wait','postgres']);
  await worker('node','db/migrate.mjs');
  await worker('node','tests/helpers/backup-seed.mjs');
  assert.match(await accounting('--bootstrap'),/Storage accounting ready for 1 owner/);
  // A retry after an interrupted deployment must be idempotent.
  assert.match(await accounting('--bootstrap'),/Storage accounting ready for 1 owner/);
  await accounting('--recover');
  await accounting('--reconcile');
  await worker('node','--import','tsx','scripts/storage-maintenance.ts');
  await worker('node','--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {lstat,readdir} from 'node:fs/promises';
    import {join} from 'node:path';
    import pg from 'pg';
    async function bytes(path) {
      const info=await lstat(path);
      if(!info.isDirectory())return info.size;
      let total=0;for(const name of await readdir(path))total+=await bytes(join(path,name));return total;
    }
    const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
    try {
      const {rows:[usage]}=await db.query('SELECT * FROM storage_usage');
      const actual=await bytes('/app/workspaces/repos')+await bytes('/app/workspaces/objects');
      assert.ok(actual>0);assert.equal(Number(usage.bytes),actual);assert.equal(usage.initialized,true);
      assert.equal(Number(usage.reserved_bytes),0);
      const {rows:[resources]}=await db.query('SELECT count(*)::int AS n,sum(bytes) AS bytes FROM storage_resources');
      assert.equal(resources.n,2);assert.equal(Number(resources.bytes),actual);
      const {rows:[capacity]}=await db.query('SELECT reserved_bytes FROM storage_capacity');
      assert.equal(Number(capacity.reserved_bytes),0);
      assert.equal((await db.query('SELECT * FROM storage_reservations')).rowCount,0);
    } finally {await db.end();}
  `);
  console.log('PASS: shipped worker migrates, bootstraps/retries/reconciles exact repository and activity bytes, recovers reservations, and starts the maintenance CLI.');
} finally {
  await docker([...compose,'down','--volumes','--remove-orphans']);
  await rm(directory,{recursive:true,force:true});
}
