import nextEnv from '@next/env';
import assert from 'node:assert/strict';
import { spawn, fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { request } from 'undici';
import { fixture } from '../../tests/load/fixture.mjs';
import { dispatchers } from '../../tests/load/transport.mjs';
import { compute } from './typescript/compute.ts';

// Run with node --import tsx. Both services are built ahead of measurement.
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
const hard = option('--profile','smoke') === 'hard';
const seconds = Number(option('--seconds',hard ? '10' : '2'));
const rounds = Number(option('--rounds',hard ? '2' : '1'));
const users = hard ? 10000 : 40;
assert(seconds > 0 && seconds <= 120 && rounds > 0 && rounds <= 5);
nextEnv.loadEnvConfig(process.cwd());
const databaseUrl = process.env.LOAD_TEST_DATABASE_URL || process.env.DATABASE_URL;
assert(databaseUrl, 'DATABASE_URL is required; only a new isolated schema will be mutated');
const scratch = await mkdtemp(join(tmpdir(),'runtime-compare-'));
const reportPath = resolve('.load-test-results',`runtime-${Date.now()}.json`);
await mkdir(resolve('.load-test-results'),{recursive:true});
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const report = { version:1, profile:hard?'hard':'smoke', seconds, rounds, users,
  environment:{node:process.version,go:execFileSync('go',['version'],{encoding:'utf8'}).trim(),
    platform:process.platform,arch:process.arch,cpus:cpus().length,memoryBytes:totalmem(),sameHostGenerator:true,
    computeWorkers:4,databasePool:10,httpConnections:256},trials:[],status:'running' };
let data, active;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT',interrupt); process.on('SIGTERM',interrupt);
const sha = value => createHash('sha256').update(value).digest('hex');
const graphInput = {nodes:hard?20000:1000,rounds:hard?32:8,seed:73};
const graphExpected = compute({kind:'graph',...graphInput});
const count = hard ? 10000 : 500;
const baseFiles = Array.from({length:count},(_,index)=>({path:`src/f-${String(index).padStart(5,'0')}.ts`,sha:'0000000000000000',size:1024}));
const headFiles = baseFiles.filter((_,index)=>index%10!==0).map((file,index)=>index%3===0?{...file,sha:'1111111111111111',size:2048}:file);
for (let index=0;index<count/10;index++) headFiles.push({path:`added/${index}.ts`,sha:'2222222222222222',size:4096});
const snapshotInput = {base:baseFiles,head:headFiles};
const snapshotExpected = compute({kind:'snapshot',...snapshotInput});
const graphBody = JSON.stringify(graphInput), snapshotBody = JSON.stringify(snapshotInput);
const queries = JSON.parse(await (await import('node:fs/promises')).readFile('benchmarks/runtime/sql/queries.json','utf8'));
let gitExpected, gitBase, gitHead;
const gitRepo = join(scratch,'git-fixture');

function summary(values) {
  values.sort((a,b)=>a-b);
  const percentile = p => values.length ? +values[Math.min(values.length-1,Math.ceil(values.length*p)-1)].toFixed(3) : null;
  return {count:values.length,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maxMs:percentile(1)};
}
async function parallel(count, concurrency, work) {
  let index=0;
  await Promise.all(Array.from({length:Math.min(count,concurrency)},async()=>{
    while(index<count) { const current=index++; if(interrupted) throw new Error('Interrupted'); await work(current); }
  }));
}
async function prepareGit() {
  await mkdir(gitRepo);
  const git = (...args) => execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:gitRepo,env:{...environment,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},encoding:'utf8'}).trim();
  git('init','--quiet'); git('config','user.email','benchmark@example.test');git('config','user.name','Benchmark');
  const content = Array.from({length:1024},(_,i)=>`line ${i} repeated source content\n`).join('');
  await parallel(500,16,index=>writeFile(join(gitRepo,`file-${index}.md`),content));
  git('add','.');git('commit','--quiet','-m','base');gitBase=git('rev-parse','HEAD');
  await parallel(125,16,index=>writeFile(join(gitRepo,`file-${index}.md`),content.replaceAll('source','changed')));
  await parallel(25,8,index=>rm(join(gitRepo,`file-${index+125}.md`)));
  await parallel(25,8,index=>writeFile(join(gitRepo,`added-${index}.md`),content));
  git('add','.');git('commit','--quiet','-m','head');gitHead=git('rev-parse','HEAD');
  const result=execFileSync('git',['diff','--no-ext-diff','--no-textconv','--numstat',gitBase,gitHead],{cwd:gitRepo,env:environment});
  gitExpected={bytes:result.length,sha256:sha(result)};
}
async function start(runtime) {
  const key=randomBytes(32).toString('hex');
  const connection=new URL(data.databaseUrl);connection.searchParams.delete('options');
  const child=spawn(runtime==='go'?resolve('.test-build/runtime/go-server'):process.execPath,
    runtime==='go'?[]:[resolve('.test-build/runtime/server.cjs')],{
      env:{...environment,DATABASE_URL:connection.toString(),BENCHMARK_SCHEMA:data.schema,BENCHMARK_KEY:key,
        BENCHMARK_SQL:resolve('benchmarks/runtime/sql/queries.json'),BENCHMARK_WORKER:resolve('.test-build/runtime/worker.cjs'),
        BENCHMARK_REPO:gitRepo,GIT_BASE:gitBase,GIT_HEAD:gitHead,DB_POOL:'10',COMPUTE_WORKERS:'4',PORT:'0'},
      stdio:['ignore','pipe','pipe']});
  let logs='',stdout='';child.stderr.on('data',chunk=>{logs=(logs+chunk).slice(-16000);});
  const service={child,key,peakRss:0,resourceSamples:0,log:()=>logs,agents:dispatchers(256)};
  active=service;
  const sampler=fork(resolve('tests/load/resources.mjs'),[String(child.pid)],{execArgv:[],stdio:['ignore','ignore','ignore','ipc']});
  service.sampler=sampler;
  sampler.on('message',message=>{if(message.rss){service.peakRss=Math.max(service.peakRss,message.rss);service.resourceSamples++;}});
  sampler.on('error',error=>{logs+=error.message;});
  const port=await new Promise((resolvePort,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Service startup timeout: '+logs)),15000);
    child.once('error',reject);child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Service exited: '+logs));});
    child.stdout.on('data',chunk=>{stdout+=chunk;const line=stdout.split('\n')[0];if(stdout.includes('\n')){clearTimeout(timeout);try{resolvePort(JSON.parse(line).port);}catch(error){reject(error);}}});
  });
  service.url=`http://127.0.0.1:${port}`;
  service.call=async(path,{method='GET',body,user=data.users[1],index=0,signal,dispatcher,headers={}}={})=>{
    const response=await request(service.url+path,{method,body:typeof body==='string'?body:body===undefined?undefined:JSON.stringify(body),
      headers:{'x-benchmark-key':key,authorization:`Bearer ${user.token}`,'content-type':'application/json',...headers},
      dispatcher:dispatcher??service.agents.forUser(index),signal:signal??AbortSignal.timeout(15000),headersTimeout:15000,bodyTimeout:15000});
    const text=await response.body.text();
    return {status:response.statusCode,value:JSON.parse(text),timing:response.headers['server-timing']};
  };
  assert.equal((await service.call('/health')).status,200);
  return service;
}
async function stop(service) {
  if(!service)return;
  await service.agents.destroy();
  if(service.sampler?.connected){const stopped=once(service.sampler,'exit');service.sampler.disconnect();await stopped;}
  if(service.child.exitCode===null && service.child.signalCode===null){
    const stopped=once(service.child,'exit');service.child.kill('SIGTERM');
    await Promise.race([stopped,delay(6000,undefined,{ref:false})]);
    if(service.child.exitCode===null && service.child.signalCode===null){service.child.kill('SIGKILL');await stopped;}
  }
  active=undefined;
}
const payload = (user,id=randomUUID()) => ({id,runId:user.runId,room:user.roomId,assigneeId:user.assignee.id,body:'Compare durable task writes 🧪'});
async function contract(service) {
  const checks=[];
  const check=async(name,work)=>{try{await work();checks.push(name);}catch(error){throw new Error(`Contract failed: ${name}`,{cause:error});}};
  const call=service.call,user=data.users[1], outsider=data.users[21];
  await check('benchmark key and token required',async()=>{
    assert.equal((await call('/health',{headers:{'x-benchmark-key':'invalid'}})).status,401);
    assert.equal((await call(`/rooms/${user.roomId}/tasks`,{headers:{authorization:'Bearer invalid'}})).status,401);
  });
  await check('cross-room access denied',async()=>assert.equal((await call(`/rooms/${user.roomId}/tasks`,{user:outsider})).status,403));
  await check('read results equal shared SQL',async()=>{
    for(const name of ['tasks','roster'])assert.deepEqual((await call(`/rooms/${user.roomId}/${name}`)).value,JSON.parse((await data.pool.query(queries[name],[user.roomId,user.id])).rows[0].body));
  });
  await check('revoked token denied immediately',async()=>{
    await data.pool.query('UPDATE auth_tokens SET revoked_at=now() WHERE user_id=$1',[user.id]);
    try{assert.equal((await call(`/rooms/${user.roomId}/tasks`)).status,401);}finally{await data.pool.query('UPDATE auth_tokens SET revoked_at=NULL WHERE user_id=$1',[user.id]);}
  });
  await check('64 concurrent duplicate writes produce exactly one task',async()=>{
    const task=payload(user);
    await parallel(64,64,async index=>{const result=await call('/tasks',{method:'POST',body:task,index});assert.equal(result.status,201);assert.equal(result.value.id,task.id);});
    assert.equal((await data.pool.query('SELECT count(*)::int AS n FROM room_tasks WHERE id=$1',[task.id])).rows[0].n,1);
    assert.equal((await call('/tasks',{method:'POST',body:{...task,body:'conflicting payload'}})).status,409);
    assert.equal((await call(`/tasks/${task.id}`,{method:'PATCH',user:outsider})).status,403);
    assert.equal((await call(`/tasks/${task.id}`,{method:'PATCH',user:user.assignee})).status,200);
    assert.equal((await data.pool.query('SELECT status FROM room_tasks WHERE id=$1',[task.id])).rows[0].status,'done');
  });
  await check('viewer cannot assign tasks',async()=>{
    await data.pool.query("UPDATE session_members SET role='viewer' WHERE user_id=$1",[user.id]);
    await data.pool.query("UPDATE project_members SET role='viewer' WHERE user_id=$1",[user.id]);
    try{assert.equal((await call('/tasks',{method:'POST',body:payload(user)})).status,403);}finally{
      await data.pool.query("UPDATE session_members SET role='editor' WHERE user_id=$1",[user.id]);
      await data.pool.query("UPDATE project_members SET role='editor' WHERE user_id=$1",[user.id]);
    }
  });
  await check('invalid bodies rejected and oversized body bounded',async()=>{
    for(const body of ['{', 'null', '[]', JSON.stringify({...graphInput,seed:null}),JSON.stringify({...graphInput,nodes:25001})])assert.equal((await call('/graph',{method:'POST',body})).status,400);
    assert.equal((await call('/graph',{method:'POST',body:' '.repeat(2*1024*1024+1)})).status,413);
    assert.equal((await call('/snapshot',{method:'POST',body:{base:[{path:'x',sha:'0000000000000000'}],head:[]}})).status,400);
    assert.equal((await call(`/rooms/${user.roomId}/events`,{method:'POST',body:{id:33,body:null,at:0}})).status,400);
  });
  await check('graph snapshot and Git outputs verified',async()=>{
    for(const [path,body,expected] of [['/graph',graphBody,graphExpected],['/snapshot',snapshotBody,snapshotExpected],['/git',undefined,gitExpected]]){
      const response=await call(path,{method:body?'POST':'GET',body});assert.equal(response.status,200);assert.deepEqual(response.value,expected);
    }
  });
  await check('database recovers after clients cancel',async()=>{
    await parallel(32,32,async index=>{try{await call('/hold',{index,signal:AbortSignal.timeout(20)});}catch{ /* deliberate cancellation */ }});
    await delay(500);assert.equal((await call(`/rooms/${user.roomId}/tasks`)).status,200);
  });
  if(hard)await check('CPU overload rejects excess work and recovers',async()=>{
    const agents=dispatchers(512),status={};
    try{
      await parallel(512,512,async index=>{
        // Ramp socket handshakes below the host listen backlog; still overload CPU work.
        await delay(Math.floor(index/32)*20);
        const result=await call('/graph',{method:'POST',body:graphBody,index,dispatcher:agents.forUser(index)});
        assert([200,503].includes(result.status));status[result.status]=(status[result.status]??0)+1;
        if(result.status===200)assert.deepEqual(result.value,graphExpected);
      });
      assert(status[200]>0 && status[503]>0,'Must exercise both accepted and rejected work');
      assert.equal((await call('/stats')).value.queued,0);
      assert.equal((await call('/health')).status,200);
    }finally{await agents.destroy();}
  });
  return checks;
}
async function measure(service,name,concurrency,operation,{rate=0,total}={}) {
  console.log(`  ${name}: concurrency ${concurrency}${rate?`, offered ${rate}/sec`:''}`);
  const before=(await service.call('/stats')).value;
  service.peakRss=0;service.resourceSamples=0;
  const lag=monitorEventLoopDelay({resolution:20});lag.enable();
  const rows=new Map(), failures=[], pending=new Set();let index=0,missed=0;
  const start=performance.now(),until=start+seconds*1000;
  async function one(current,scheduled=performance.now()) {
    let result,kind='request',valid=false;
    try{const value=await operation(current);kind=value.kind;result=value.result;valid=value.valid;}
    catch(error){if(failures.length<8)failures.push(error.message);}
    const row=rows.get(kind)??{times:[],pool:[],db:[],failed:0,status:{}};
    rows.set(kind,row);row.times.push(performance.now()-scheduled);
    const status=result?.status??'network';row.status[status]=(row.status[status]??0)+1;
    if(!valid){row.failed++;if(failures.length<8)failures.push(`${kind}: ${status}`);}
    for(const match of result?.timing?.matchAll(/(pool|db);dur=([\d.]+)/g)??[])row[match[1]].push(Number(match[2]));
  }
  if(rate){
    const offered=Math.floor(seconds*rate);
    for(let n=0;n<offered;n++){
      if(interrupted)throw new Error('Interrupted');
      const scheduled=start+n*1000/rate,wait=scheduled-performance.now();if(wait>0)await delay(wait);
      if(pending.size>=concurrency){missed++;continue;}
      const job=one(index++,scheduled);pending.add(job);void job.finally(()=>pending.delete(job));
    }
    await Promise.all(pending);
  }else{
    await Promise.all(Array.from({length:concurrency},async()=>{
      while(!interrupted && (total?index<total:performance.now()<until)){const current=index++;await one(current);}
    }));
  }
  const duration=(performance.now()-start)/1000;lag.disable();
  const after=(await service.call('/stats')).value;
  const result={name,concurrency,offeredRate:rate||null,missedStarts:missed,durationSeconds:+duration.toFixed(3),
    requests:index,requestsPerSecond:+(index/duration).toFixed(2),
    failed:[...rows.values()].reduce((sum,row)=>sum+row.failed,0),failures,
    cpuSeconds:((after.cpuUserMicros+after.cpuSystemMicros)-(before.cpuUserMicros+before.cpuSystemMicros))/1e6,
    peakServerRssBytes:service.peakRss||null,resourceSamples:service.resourceSamples,
    generatorLagP99Ms:+(lag.percentile(99)/1e6).toFixed(2),generatorLagMaxMs:+(lag.max/1e6).toFixed(2),
    operations:[...rows].map(([operation,row])=>({operation,...summary(row.times),failed:row.failed,status:row.status,pool:summary(row.pool),database:summary(row.db)}))};
  console.log(`    ${result.requestsPerSecond}/sec, ${result.failed} failed, p95 ${result.operations.map(row=>`${row.operation}=${row.p95Ms}ms`).join(', ')}`);
  return result;
}
function operations(service) {
  const call=service.call;
  return {
    read:async index=>{const user=data.users[index%users],kind=index%2?'roster':'tasks';const result=await call(`/rooms/${user.roomId}/${kind}`,{user,index});return{kind,result,valid:result.status===200&&Array.isArray(result.value)&&result.value.length>0};},
    write:async index=>{const user=data.users[index%users],task=payload(user);const result=await call('/tasks',{method:'POST',body:task,user,index});return{kind:'write',result,valid:result.status===201&&result.value.id===task.id};},
    graph:async index=>{const result=await call('/graph',{method:'POST',body:graphBody,index});return{kind:'graph',result,valid:result.status===200&&Object.keys(graphExpected).every(key=>graphExpected[key]===result.value[key])};},
    snapshot:async index=>{const result=await call('/snapshot',{method:'POST',body:snapshotBody,index});return{kind:'snapshot',result,valid:result.status===200&&Object.keys(snapshotExpected).every(key=>snapshotExpected[key]===result.value[key])};},
    git:async index=>{const result=await call('/git',{index});return{kind:'git',result,valid:result.status===200&&result.value.sha256===gitExpected.sha256&&result.value.bytes===gitExpected.bytes};},
    hold:async index=>{const result=await call('/hold',{index,user:data.users[index%users]});return{kind:'hold',result,valid:result.status===200&&result.value.ok===true};},
  };
}
async function live(service,count,op) {
  console.log(`  Connecting ${count} authenticated live users…`);
  const agents=dispatchers(count),controllers=[],readers=[],events=new Map(),latencies=[];
  let ready=0,received=0,unexpected=0,streamErrors=0,closing=false;
  const start=performance.now();
  try{
    await parallel(count,64,async index=>{
      const user=data.users[index],controller=new AbortController();controllers.push(controller);
      let resolveReady,rejectReady;
      const waiting=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
      const timeout=setTimeout(()=>{rejectReady(new Error('Live connection timeout'));controller.abort();},15000);
      const reader=(async()=>{
        try{
          const response=await request(`${service.url}/rooms/${user.roomId}/events`,{headers:{'x-benchmark-key':service.key,authorization:`Bearer ${user.token}`},
            dispatcher:agents.forUser(index),signal:controller.signal,headersTimeout:15000,bodyTimeout:0});
          assert.equal(response.statusCode,200);let buffer='';
          for await(const chunk of response.body){
            buffer+=chunk.toString();let end;
            while((end=buffer.indexOf('\n\n'))>=0){
              const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!frame.startsWith('data: '))continue;
              const event=JSON.parse(frame.slice(6));
              if(event.ready){assert.equal(event.ready,user.roomId);ready++;clearTimeout(timeout);resolveReady();continue;}
              const expected=events.get(event.id);
              if(!expected || event.room!==user.roomId || !expected.pending.delete(user.id)){unexpected++;continue;}
              received++;latencies.push(performance.now()-expected.at);
            }
          }
          if(!closing)streamErrors++;
        }catch(error){if(!closing){streamErrors++;rejectReady(error);}}
        finally{clearTimeout(timeout);}
      })();readers.push(reader);await waiting;
    });
    const connectionSeconds=(performance.now()-start)/1000;
    assert.equal((await service.call('/stats')).value.openStreams,count);
    const rooms=data.rooms.filter(room=>room.members[0].index<count);
    async function publishCycle(){
      await parallel(rooms.length,32,async index=>{
        const room=rooms[index],id=randomUUID(),members=room.members.filter(user=>user.index<count);
        events.set(id,{at:performance.now(),pending:new Set(members.map(user=>user.id))});
        const response=await service.call(`/rooms/${room.id}/events`,{method:'POST',user:members[0],index,body:{id,body:'shared activity',at:Date.now()}});
        assert.equal(response.status,200);
      });
    }
    const eventStarted=performance.now();
    const duringLoad=publishCycle();
    const scenario=await measure(service,`mixed-with-${count}-live-users`,hard?128:16,async index=>{
      // No Git subprocesses during 10k connections: macOS posix_spawn has an FD limit.
      const choice=index%20;
      if(choice<14)return op.read(index);if(choice<18)return op.write(index);if(choice===18)return op.graph(index);return op.snapshot(index);
    });
    await duringLoad;
    const cycles=4;
    for(let cycle=1;cycle<cycles;cycle++)await publishCycle();
    const deadline=performance.now()+15000;
    while(received<count*cycles && performance.now()<deadline && !interrupted)await delay(20);
    const stats=(await service.call('/stats')).value;
    const result={...scenario,streams:count,ready,connectionSeconds:+connectionSeconds.toFixed(3),
      expectedDeliveries:count*cycles,received,unexpected,streamErrors,dropped:stats.dropped,
      delivery:summary(latencies),deliverySeconds:+((performance.now()-eventStarted)/1000).toFixed(3)};
    console.log(`    Live delivery: ${received}/${count*cycles}, p95 ${result.delivery.p95Ms}ms, ${streamErrors} stream errors`);
    return result;
  }finally{
    closing=true;for(const controller of controllers)controller.abort();
    await agents.destroy();await Promise.allSettled(readers);
    const deadline=performance.now()+5000;
    while((await service.call('/stats')).value.openStreams && performance.now()<deadline)await delay(25);
    assert.equal((await service.call('/stats')).value.openStreams,0);
  }
}

try {
  await prepareGit();
  data=await fixture(databaseUrl,{users,'room-size':10},join(scratch,'data'));
  report.fixture={users,rooms:data.rooms.length,seededTasks:users*10,snapshotBytes:Buffer.byteLength(snapshotBody),graph:graphInput,
    git:{files:500,modified:125,deleted:25,added:25},graphExpected,snapshotExpected,gitExpected};
  for(let round=0;round<rounds;round++){
    for(const runtime of round%2?['go','typescript']:['typescript','go']){
      if(interrupted)throw new Error('Interrupted');
      console.log(`Round ${round+1}/${rounds}: ${runtime}`);
      await data.pool.query('TRUNCATE room_tasks');
      await data.pool.query(`INSERT INTO room_tasks(id,run_id,created_by,assignee_id,body)
        SELECT gen_random_uuid(),r.id,r.started_by,r.started_by,'Seeded task '||n FROM agent_runs r CROSS JOIN generate_series(1,10) n`);
      await data.pool.query('ANALYZE room_tasks');
      const service=await start(runtime),trial={runtime,round:round+1,checks:[],scenarios:[]};report.trials.push(trial);
      try{
        trial.checks=await contract(service);console.log(`  ${trial.checks.length} contract groups passed`);
        const op=operations(service);
        // Warm both JIT and database caches; exclude all warmup traffic.
        await parallel(160,16,index=>op.read(index));await parallel(40,4,index=>op.graph(index));await parallel(16,4,index=>op.snapshot(index));
        for(const [name,concurrency,work,options] of [
          ['database-reads',hard?256:16,op.read],['transaction-writes',hard?128:16,op.write],
          ['database-fixed-rate',hard?256:16,op.read,{rate:hard?1000:100}],
          ['database-pool-saturation',hard?128:16,op.hold,{total:hard?256:32}],
          ['cpu-graph',hard?32:8,op.graph],['large-snapshot',hard?16:4,op.snapshot],['git-diff',hard?32:8,op.git],
        ])trial.scenarios.push(await measure(service,name,concurrency,work,options));
        for(const count of hard?[1000,10000]:[40])trial.scenarios.push(await live(service,count,op));
        const stats=(await service.call('/stats')).value;trial.finalStats=stats;
        trial.persistedTasks=Number((await data.pool.query('SELECT count(*) AS n FROM room_tasks')).rows[0].n);
        const successfulWrites=trial.scenarios.flatMap(row=>row.operations).filter(row=>row.operation==='write').reduce((sum,row)=>sum+row.count-row.failed,0);
        assert.equal(trial.persistedTasks,users*10+1+successfulWrites,'Every acknowledged task must exist exactly once');
        assert.equal(stats.errors,0,'Unexpected server errors');assert.equal(stats.openStreams,0);
        trial.serverLog=service.log();
      }finally{trial.serverLog=service.log();if(trial.serverLog)console.log(trial.serverLog);await stop(service);}
      await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
    }
  }
  report.status=report.trials.every(trial=>trial.scenarios.every(row=>row.failed===0 && row.missedStarts===0 && (!row.streams || (row.received===row.expectedDeliveries && !row.unexpected && !row.streamErrors && !row.dropped))))?'passed':'failed';
}catch(error){report.status='failed';report.error=error.stack;report.cause=error.cause?.stack;console.error(error);}
finally{
  const errors=[];
  try{await stop(active);}catch(error){errors.push(error.message);}
  try{await data?.close();}catch(error){errors.push(error.message);}
  try{await rm(scratch,{recursive:true,force:true});}catch(error){errors.push(error.message);}
  report.cleanup={ok:errors.length===0,errors};if(errors.length)report.status='failed';
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(`${report.status.toUpperCase()}: ${reportPath}`);
  process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);
  process.exitCode=report.status==='passed'?0:1;
}
