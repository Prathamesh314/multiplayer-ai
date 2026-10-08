import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {deploymentPlan,checkRollback} from '../scripts/deploy-schema.mjs';
import {checkWebRuntime} from '../scripts/check-web-runtime.mjs';

const base='048_collaboration_flow.sql',added='049_storage_accounting.sql',hash='a'.repeat(64);
const migrations=[{name:base,sha256:'b'.repeat(64)},{name:added,sha256:hash}];
test('unreviewed or modified migrations are refused before deployment',()=>{
  assert.throws(()=>deploymentPlan([base],migrations,{}),/no reviewed/);
  assert.throws(()=>deploymentPlan([base],migrations,{[added]:'c'.repeat(64)}),/no reviewed/);
  assert.throws(()=>deploymentPlan([base,'050_missing.sql'],migrations,{}),/every applied/);
  assert.throws(()=>deploymentPlan([base,base],migrations,{}),/Invalid/);
});
test('rollback permits only the unchanged schema or a subset of approved additions',()=>{
  const plan=deploymentPlan([base],migrations,{[added]:hash});
  checkRollback(plan,[base]);checkRollback(plan,[base,added]);
  assert.throws(()=>checkRollback(plan,[base,added,'050_unknown.sql']),/outside/);
  assert.throws(()=>checkRollback(plan,[added]),/outside/);
  assert.deepEqual(deploymentPlan([base,added],migrations,{}).pending,[]);
});
test('the approved storage migration matches the exact reviewed SQL',async()=>{
  const approved=JSON.parse(await readFile(new URL('../db/deploy-compatible-migrations.json',import.meta.url),'utf8'));
  assert.equal(approved[added],createHash('sha256').update(await readFile(new URL('../db/migrations/'+added,import.meta.url))).digest('hex'));
});
async function server(t,handler) {
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  return 'http://127.0.0.1:'+server.address().port;
}
test('candidate readiness retries startup, then checks each public page',async t=>{
  const seen=[];let probes=0;
  const base=await server(t,(req,res)=>{seen.push(req.url);res.writeHead(req.url==='/health/ready'&&++probes<3?503:200);res.end('fixture');});
  await checkWebRuntime({base,timeoutMs:1000,pollMs:5});
  assert.deepEqual(seen,['/health/ready','/health/ready','/health/ready','/','/login','/workspace']);
});
test('an unhealthy candidate or broken page refuses activation',async t=>{
  const unhealthy=await server(t,(_req,res)=>{res.writeHead(503);res.end();});
  await assert.rejects(checkWebRuntime({base:unhealthy,timeoutMs:80,pollMs:5}),/did not become ready/);
  const broken=await server(t,(req,res)=>{res.writeHead(req.url==='/workspace'?500:200);res.end();});
  await assert.rejects(checkWebRuntime({base:broken,timeoutMs:1000,pollMs:5}),/workspace.*500/);
});
test('asset CDN preflight requires public asset headers and rejects exposed APIs',async t=>{
  const app=await server(t,(_req,res)=>res.end('fixture'));
  let exposeApi=false;
  const assets=await server(t,(req,res)=>{
    if(req.url==='/docs/images/workspace.webp')res.writeHead(200,{'content-type':'image/webp','access-control-allow-origin':'*','x-multiplayer-public-assets':'1'}).end('fixture');
    else res.writeHead(exposeApi?200:404).end();
  });
  await checkWebRuntime({base:app,assetPrefix:assets});
  exposeApi=true;
  await assert.rejects(checkWebRuntime({base:app,assetPrefix:assets}),/must not expose/);
  await assert.rejects(checkWebRuntime({base:app,assetPrefix:app}),/Asset CDN is not ready/);
});

test('missing Clerk credentials refuse activation before any network or traffic change',async()=>{
  const keys=['NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY','CLERK_SECRET_KEY','CLERK_WEBHOOK_SIGNING_SECRET'];
  const before=keys.map(key=>process.env[key]);
  try{for(const key of keys)delete process.env[key];await assert.rejects(checkWebRuntime({requireAuth:true}),/Clerk authentication is not configured/);}
  finally{keys.forEach((key,index)=>{if(before[index]===undefined)delete process.env[key];else process.env[key]=before[index];});}
});
