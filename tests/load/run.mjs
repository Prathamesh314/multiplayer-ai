import nextEnv from '@next/env';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, stat, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir, platform, cpus, totalmem } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once, setMaxListeners } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { options, failuresFor } from './core.mjs';
import { fixture } from './fixture.mjs';
import { workload } from './workload.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
process.chdir(root);
if (process.argv.includes('--help')) {
  console.log(`Usage: npm run test:load -- [--profile smoke|100|1000|10000] [--users N] [--duration SECONDS] [--ramp SECONDS]
  --room-size 10 --poll-ms 5000 --write-ms 30000 --timeout-ms 10000
  --p95-ms 1500 --error-rate 0.01 --sse 1 --port 0
Requires a production build, PostgreSQL and Redis. Starts its own loopback server.
Reports: .load-test-results/<run>.json and <run>.server.log. No AI execution.`);
  process.exit(0);
}
const config=options(process.argv.slice(2));
nextEnv.loadEnvConfig(root);
const databaseUrl=process.env.LOAD_TEST_DATABASE_URL||process.env.DATABASE_URL;
const redisUrl=process.env.LOAD_TEST_REDIS_URL||process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('Set DATABASE_URL and REDIS_URL (or LOAD_TEST_DATABASE_URL and LOAD_TEST_REDIS_URL).');
await access(join(root,'.next','BUILD_ID')).catch(()=>{throw new Error('Run npm run build -- --webpack before the load test.');});
const runId=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8);
const reportDirectory=join(root,'.load-test-results'); await mkdir(reportDirectory,{recursive:true,mode:0o700});
const reportPath=join(reportDirectory,runId+'.json'), logPath=join(reportDirectory,runId+'.server.log');
const scratch=await mkdtemp(join(tmpdir(),'multiplayer-load-'));
const control=new AbortController(); setMaxListeners(0,control.signal);
const interrupt=()=>{console.log('Stopping load test and cleaning up its fixtures…');control.abort();};
process.once('SIGINT',interrupt); process.once('SIGTERM',interrupt);
const redis=createClient({url:redisUrl,socket:{connectTimeout:5000,reconnectStrategy:false}});
redis.on('error',()=>{});
const log=createWriteStream(logPath,{flags:'wx',mode:0o600});
let data,server,sampling,report={config,status:'failed'},sampleRunning=false;
const resources={serverRssSupported:platform()!=='win32',serverPeakRssBytes:null,generatorPeakRssBytes:0,samples:0};
const lag=monitorEventLoopDelay({resolution:20});
async function sample() {
  if (sampleRunning) return;
  sampleRunning=true;
  try {
    resources.samples++;
    resources.generatorPeakRssBytes=Math.max(resources.generatorPeakRssBytes,process.memoryUsage().rss);
    if (resources.serverRssSupported && server?.pid && server.exitCode===null) {
      const {stdout}=await promisify(execFile)('ps',['-o','rss=','-p',String(server.pid)],{timeout:2000});
      const rss=Number(stdout.trim())*1024;
      if (Number.isFinite(rss) && rss>0) resources.serverPeakRssBytes=Math.max(resources.serverPeakRssBytes??0,rss);
    }
  } catch { /* Leave unavailable resource measurements explicitly null. */ }
  finally { sampleRunning=false; }
}
async function directoryBytes(path) {
  let bytes=0;
  for (const entry of await readdir(path,{withFileTypes:true}).catch(()=>[])) {
    const child=join(path,entry.name);
    if (entry.isDirectory()) bytes+=await directoryBytes(child);
    else if (entry.isFile()) bytes+=(await stat(child)).size;
  }
  return bytes;
}
async function availablePort() {
  const probe=createServer(); probe.listen(config.port,'127.0.0.1'); await once(probe,'listening');
  const port=probe.address().port; await new Promise(resolve=>probe.close(resolve)); return port;
}
async function stopServer() {
  if (!server || server.exitCode!==null || server.signalCode!==null || !server.pid) return;
  const stopped=once(server,'exit').catch(()=>{});
  server.kill('SIGTERM');
  await Promise.race([stopped,delay(5000)]);
  if (server.exitCode===null && server.signalCode===null) { server.kill('SIGKILL'); await stopped; }
}
try {
  await redis.connect(); await redis.ping();
  console.log(`Preparing ${config.users} users in an isolated database schema; ${config['room-size']} users per room.`);
  data=await fixture(databaseUrl,config,join(scratch,'data'));
  if (control.signal.aborted) throw new Error('Interrupted during setup');
  const port=await availablePort(), base=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{
    cwd:root,env:{...process.env,DATABASE_URL:data.databaseUrl,REDIS_URL:redisUrl,NODE_ENV:'production',NEXT_TEST_DIST_DIR:'.next',
      MULTIPLAYER_AI_DATA:join(scratch,'data'),STORAGE_PROVIDER:'local',STORAGE_LOCAL_DIR:join(scratch,'objects'),STORAGE_PREFIX:'',STORAGE_COLD_GIT:'0',
      NEXT_TELEMETRY_DISABLED:'1',AGENT_WORKER:'0',LOCAL_RUNNERS:'1',MNEMOSYNE_URL:'',MEMORY_EXTRACTION_URL:''},stdio:['ignore','pipe','pipe']});
  let spawnError; server.on('error',error=>{spawnError=error;});
  server.stdout.pipe(log,{end:false}); server.stderr.pipe(log,{end:false});
  let ready=false;
  for (let attempt=0;attempt<120 && !control.signal.aborted;attempt++) {
    if (spawnError || server.exitCode!==null) throw new Error('The isolated server did not start; see its log.');
    try {
      const response=await fetch(base+'/api/auth/me',{headers:{cookie:`ma_auth=${data.users[0].token}`},signal:AbortSignal.timeout(1000)});
      ready=response.ok && (await response.json()).user?.id===data.users[0].id;
      if (ready) break;
    } catch {}
    await delay(500);
  }
  if (!ready) throw new Error('Could not verify the isolated server identity. No workload was sent.');
  // Warm representative read routes before starting the measured ramp.
  for (const path of ['/api/tasks',`/api/tasks?sessionId=${data.users[0].roomId}`,`/api/sessions/${data.users[0].roomId}/tree`]) {
    const response=await fetch(base+path,{headers:{cookie:`ma_auth=${data.users[0].token}`},signal:AbortSignal.timeout(10000)});
    await response.arrayBuffer(); if (!response.ok) throw new Error('Read-route warmup failed.');
  }
  const baseline={databaseBytes:await data.bytes(),diskBytes:await directoryBytes(scratch)};
  lag.enable(); await sample(); sampling=setInterval(()=>void sample(),2000);
  console.log(`Running ${config.ramp}s ramp + ${config.duration}s steady load on ${base}.`);
  const result=await workload(base,data,config,control.signal,state=>console.log(`${state.phase}: ${state.activatedUsers} users, ${state.openStreams} live streams, ${state.inflight} requests in flight`));
  await sample(); lag.disable();
  const after={databaseBytes:await data.bytes(),diskBytes:await directoryBytes(scratch)};
  report={version:1,runId,createdAt:new Date().toISOString(),config,environment:{node:process.version,platform:platform(),cpuCount:cpus().length,hostMemoryBytes:totalmem(),
    target:'isolated local production Next.js server',sameHostGenerator:true,redis:'enabled'},...result,
    resources:{...resources,generatorEventLoopP99Ms:Math.round(lag.percentile(99)/1e4)/100,baseline,after,
      databaseGrowthBytes:after.databaseBytes-baseline.databaseBytes,diskGrowthBytes:after.diskBytes-baseline.diskBytes}};
  report.failures=failuresFor(report,config); report.status=report.failures.length?'failed':'passed';
  const measured=report.requests.filter(row=>row.phase==='steady');
  report.steadyRequestsPerSecond=result.steadyCompletions/config.duration;
  console.table(measured.map(({operation,count,failed,p50Ms,p95Ms,p99Ms})=>({operation,count,failed,p50Ms,p95Ms,p99Ms})));
  console.log(`${report.status.toUpperCase()}: ${report.steadyRequestsPerSecond.toFixed(1)} steady requests/sec; peak server RSS ${resources.serverPeakRssBytes===null?'unavailable':(resources.serverPeakRssBytes/1048576).toFixed(1)+' MiB'}.`);
  for (const failure of report.failures) console.log('  '+failure);
} catch (error) {
  report.error=error.message; report.status='failed'; report.interrupted=control.signal.aborted;
  console.error(error.message);
} finally {
  clearInterval(sampling); lag.disable(); control.abort();
  const cleanupErrors=[];
  try { await stopServer(); } catch { cleanupErrors.push('Could not stop isolated server.'); }
  try { if (data) { if (!redis.isReady) throw new Error('Redis unavailable'); const keys=data.redisKeys(); for (let n=0;n<keys.length;n+=500) await redis.del(keys.slice(n,n+500)); } }
  catch { cleanupErrors.push('Could not remove fixture presence keys.'); }
  try { if (redis.isOpen) await redis.quit(); } catch { if (redis.isOpen) redis.destroy(); }
  try { if (data) await data.close(); } catch { cleanupErrors.push('Could not drop fixture schema.'); }
  try { await rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100}); } catch { cleanupErrors.push('Could not remove fixture files.'); }
  report.cleanup={ok:cleanupErrors.length===0,errors:cleanupErrors,schema:data?.schema??null,temporaryDirectory:scratch};
  if (cleanupErrors.length) { report.status='failed'; console.error(cleanupErrors.join('\n')); }
  await new Promise(resolve=>log.end(resolve));
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  process.removeListener('SIGINT',interrupt); process.removeListener('SIGTERM',interrupt);
  console.log('Report: '+reportPath);
  process.exitCode=report.status==='passed'?0:1;
}
