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
const candidate=project+'-candidate';
const database='postgres://fixture:test-only@postgres:5432/fixture';
const composeFile=join(directory,'compose.json');
await writeFile(composeFile,JSON.stringify({
  services:{
    postgres:{image:'pgvector/pgvector:0.8.6-pg18-trixie',environment:{POSTGRES_USER:'fixture',POSTGRES_PASSWORD:'test-only',POSTGRES_DB:'fixture'},
      healthcheck:{test:['CMD-SHELL','pg_isready -U fixture -d fixture'],interval:'1s',timeout:'3s',retries:30}},
    worker:{image,environment:{NODE_ENV:'production',DATABASE_URL:database,
      STORAGE_PROVIDER:'local',MULTIPLAYER_AI_DATA:'/app/workspaces'},volumes:['workspace:/app/workspaces']},
    redis:{image:'redis:7-alpine'},
    web:{image:process.env.TEST_WEB_IMAGE??'multiplayer-web:ci',command:['node','scripts/serve.mjs','-H','0.0.0.0','-p','3000'],
      environment:{NODE_ENV:'production',DATABASE_URL:database,REDIS_URL:'redis://redis:6379',LOCAL_RUNNERS:'1',AGENT_WORKER:'0',
        // Anonymous page/runtime checks still require configured authentication.
        // These are disposable fixture credentials, never a live Clerk account.
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:'pk_test_'+Buffer.from('fixture.clerk.accounts.dev$').toString('base64'),
        CLERK_SECRET_KEY:'sk_test_fixture',CLERK_WEBHOOK_SIGNING_SECRET:'whsec_'+Buffer.from('test-only-webhook-secret').toString('base64'),
        MULTIPLAYER_AI_TERMINAL:'0',API_TRUST_PROXY:'1',PROXY_SHARED_SECRET:'disposable-candidate-test-secret-123456789',MULTIPLAYER_AI_DATA:'/app/workspaces'},
      volumes:['workspace:/app/workspaces'],ports:['127.0.0.1::3000'],
      healthcheck:{test:['CMD','node','scripts/check-web-runtime.mjs'],interval:'2s',timeout:'5s',retries:30}},
  },volumes:{workspace:{}},
}));
const docker=async args=>(await exec('docker',args,{timeout:120_000,maxBuffer:2*1024*1024})).stdout.trim();
const compose=['compose','-p',project,'-f',composeFile];
const worker=(...args)=>docker([...compose,'run','--rm','--no-deps','-T','worker',...args]);
const accounting=mode=>worker('node','--import','tsx','scripts/storage-accounting.ts',mode);
try {
  // This must work before migrations exist, without reading or mutating the DB.
  assert.match(await accounting('--check'),/runtime is ready/);
  await docker([...compose,'up','-d','--wait','postgres']);
  await worker('node','db/migrate.mjs');
  await worker('node','tests/helpers/backup-seed.mjs');
  assert.match(await accounting('--bootstrap'),/Storage accounting ready for 1 owner/);
  // A retry after an interrupted deployment must be idempotent.
  assert.match(await accounting('--bootstrap'),/Storage accounting ready for 1 owner/);
  await accounting('--recover');
  // Simulate writes by a pre-ledger release after rollback. Roll-forward must
  // reconcile these bytes even though the owner's ledger is already initialized.
  await worker('node','-e',"require('node:fs').writeFileSync('/app/workspaces/repos/restoreroomx.git/legacy-writer-fixture','Saved by a previous release after rollback.')");
  await accounting('--reconcile');
  await worker('node','--import','tsx','scripts/storage-maintenance.ts');
  await worker('node','--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {lstat,readdir,writeFile} from 'node:fs/promises';
    import {spawnSync} from 'node:child_process';
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
      const applied=(await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row=>row.version);
      const before=applied.filter(name=>name!=='049_storage_accounting.sql');
      const plan=spawnSync(process.execPath,['scripts/deploy-schema.mjs','--plan'],{input:before.join('\\n'),encoding:'utf8',timeout:5000});
      assert.equal(plan.status,0,plan.stderr);
      assert.deepEqual(JSON.parse(plan.stdout).pending,['049_storage_accounting.sql']);
      await writeFile('/tmp/deployment-plan.json',plan.stdout);
      const rollback=spawnSync(process.execPath,['scripts/deploy-schema.mjs','--rollback','/tmp/deployment-plan.json'],{input:applied.join('\\n'),encoding:'utf8',timeout:5000});
      assert.equal(rollback.status,0,rollback.stderr);
    } finally {await db.end();}
  `);
  await docker([...compose,'up','-d','--no-deps','--wait','redis','web']);
  const original=await docker([...compose,'ps','-q','web']);
  const base='http://'+await docker([...compose,'port','web','3000']);
  // An unhealthy private candidate must leave the live container and HTTP
  // service untouched. It publishes no port and has no production DNS alias.
  await docker([...compose,'run','--rm','--no-deps','-d','--name',candidate,'-e','DATABASE_URL=postgres://fixture:test-only@127.0.0.1:1/fixture','web']);
  const network=JSON.parse(await docker(['inspect','--format','{{json .NetworkSettings}}',candidate]));
  assert.ok(Object.values(network.Ports).every(bindings=>!bindings?.length),'private candidates publish no host ports');
  assert.ok(Object.values(network.Networks).every(network=>!network.Aliases?.includes('web')&&!network.Aliases?.includes('web2')),'private candidates cannot receive load-balancer traffic via live service aliases');
  await assert.rejects(docker(['exec',candidate,'node','--input-type=module','-e',"import {checkWebRuntime} from './scripts/check-web-runtime.mjs'; await checkWebRuntime({timeoutMs:3000});"]),/did not become ready/);
  assert.equal((await fetch(base+'/login')).status,200);
  assert.equal(await docker([...compose,'ps','-q','web']),original);
  await docker(['rm','-f',candidate]);
  await docker([...compose,'run','--rm','--no-deps','-d','--name',candidate,'web']);
  await docker(['exec',candidate,'node','scripts/check-web-runtime.mjs']);
  assert.equal((await fetch(base+'/workspace')).status,200);
  assert.equal(await docker([...compose,'ps','-q','web']),original);
  console.log('PASS: deployment storage commands reconcile legacy writes; healthy/unhealthy private candidates leave the live container serving HTTP.');
} catch(error) {
  console.error(await docker([...compose,'logs','--no-color','--tail','50','web']).catch(()=>''));
  const web=await docker([...compose,'ps','--all','-q','web']).catch(()=>'');
  if(web)console.error('Web health checks:',await docker(['inspect','--format','{{json .State.Health}}',web]).catch(()=>''));
  throw error;
} finally {
  await docker(['rm','-f',candidate]).catch(()=>{});
  await docker([...compose,'down','--volumes','--remove-orphans']);
  await rm(directory,{recursive:true,force:true});
}
