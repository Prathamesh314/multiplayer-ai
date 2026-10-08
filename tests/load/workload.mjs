import {clerkCookie} from "../helpers/clerk-fixture.mjs";
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'undici';
import { Histogram, Metrics, networkFailure } from './core.mjs';
import { requestCancellation, subscribeCancellation, cancellableDelay } from './cancellation.mjs';
import { dispatchers } from './transport.mjs';

export async function workload(base,fixture,config,signal,onProgress=()=>{}) {
  // SSE occupies its connection for the whole run. Keep it out of the HTTP
  // dispatch pool so each request does not scan thousands of occupied sockets.
  // Queue time still counts toward latency and timeout; failed attempts are not retried.
  const httpAgent=dispatchers(config['http-connections']);
  const streamAgent=dispatchers(config.users);
  const metrics=new Metrics(), delivery=new Histogram(), readyLatency=new Histogram();
  const started=performance.now(), steadyStart=started+config.ramp*1000, end=steadyStart+config.duration*1000;
  let active=0,peak=0,activatedUsers=0,inflight=0,peakInflight=0,unexpectedDisconnects=0,received=0,acknowledgedTasks=0,completedTasks=0,steadyCompletions=0;
  const pendingOwn=new Set(), streams=[], streamController=new AbortController();
  const liveRooms=new Map(), pendingDelivery=new Map();
  const streamSignal=streamController.signal;
  const abortStreams=()=>streamController.abort(signal.reason);
  const detachStreams=subscribeCancellation(signal,abortStreams);
  const phase=()=>performance.now()<steadyStart?'ramp':'steady';
  const marker=`load-${randomUUID()}`;
  async function request(user,operation,path,{method='GET',body,device=false,status=200,check=()=>true}={}) {
    if (signal.aborted || performance.now()>=end) return null;
    const start=performance.now(), stage=phase(); inflight++; peakInflight=Math.max(peakInflight,inflight);
    const cancellation=requestCancellation(signal,config['timeout-ms']);
    let code='network',ok=false;
    try {
      const response=await httpRequest(base+path,{dispatcher:httpAgent.forUser(user.index),method,maxRedirections:0,headersTimeout:config['timeout-ms'],bodyTimeout:config['timeout-ms'],headers:{'content-type':'application/json',
        ...(device?{authorization:`Bearer ${user.deviceToken}`}:{cookie:clerkCookie(user.token)})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:cancellation.signal});
      code=String(response.statusCode); let data;
      try { data=await response.body.json(); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        code+=' invalid-json'; return null;
      }
      try { ok=response.statusCode===status && check(data); } catch { ok=false; }
      if (!ok && response.statusCode===status) code+=' invalid-body';
      return ok?data:null;
    } catch (error) { code=cancellation.timedOut()?'timeout':signal.aborted?'interrupted':networkFailure(error); return null; }
    finally {
      cancellation.dispose();
      const finished=performance.now();
      if (finished>=steadyStart && finished<end) steadyCompletions++;
      inflight--; metrics.record(stage,operation,finished-start,ok,code);
    }
  }
  async function openStream(user) {
    let resolveReady,rejectReady;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const controller=new AbortController(), start=performance.now(); let opened=false,reader;
    const cancel=()=>{controller.abort();void reader?.cancel().catch(()=>{});};
    const detach=subscribeCancellation(streamSignal,cancel);
    const timeout=setTimeout(()=>{controller.abort();cancel();rejectReady(new Error('Stream readiness timed out'));},config['timeout-ms']);
    const run=(async()=>{
      try {
        const response=await fetch(`${base}/api/sessions/${user.roomId}/events`,{dispatcher:streamAgent.forUser(user.index),headers:{cookie:clerkCookie(user.token)},redirect:'error',signal:controller.signal});
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Invalid event stream');
        reader=response.body.getReader();
        if (streamSignal.aborted || controller.signal.aborted) cancel();
        const decoder=new TextDecoder(); let buffer='';
        while (true) {
          const {value,done}=await reader.read(); if (done) break;
          buffer+=decoder.decode(value,{stream:true});
          if (buffer.length>1024*1024) throw new Error('Oversized event frame');
          let boundary;
          while ((boundary=buffer.indexOf('\n\n'))!==-1) {
            const frame=buffer.slice(0,boundary); buffer=buffer.slice(boundary+2);
            const line=frame.split('\n').find(line=>line.startsWith('data: '));
            if (!line) continue;
            const event=JSON.parse(line.slice(6));
            if (frame.startsWith('event: ready') && event.sessionId===user.roomId && !opened) {
              opened=true; clearTimeout(timeout); active++; peak=Math.max(peak,active);
              if (!liveRooms.has(user.roomId)) liveRooms.set(user.roomId,new Set());
              liveRooms.get(user.roomId).add(user.id);
              readyLatency.add(performance.now()-start); resolveReady();
            }
            if (event.type==='message.created' && event.message?.body?.startsWith(marker+':')) {
              const body=event.message.body,parts=body.split(':');
              if (fixture.users[Number(parts[1])]?.roomId!==user.roomId) throw new Error('Event delivered to the wrong room');
              received++; delivery.add(Math.max(0,Date.now()-Number(parts.at(-1))));
              if (event.message.userId===user.id) pendingOwn.delete(body);
              const waiting=pendingDelivery.get(body);
              if (waiting) { waiting.delete(user.id); if (!waiting.size) pendingDelivery.delete(body); }
            }
          }
        }
        if (!streamSignal.aborted) throw new Error('Event stream closed early');
      } catch (error) {
        if (!streamSignal.aborted) unexpectedDisconnects++;
        if (!opened) rejectReady(error);
      } finally { clearTimeout(timeout); detach(); if (opened) { active--; liveRooms.get(user.roomId)?.delete(user.id); } else rejectReady(new Error('Stream did not become ready')); }
    })();
    streams.push(run);
    return ready;
  }
  const progress=setInterval(()=>onProgress({phase:phase(),activatedUsers,openStreams:active,inflight}),5000);
  try {
    const outcomes=await Promise.allSettled(fixture.users.map(async user=>{
      try {
        await cancellableDelay(config.ramp*1000*user.index/config.users,signal);
        if (!await request(user,'auth','/api/auth/me',{check:data=>data.user?.id===user.id})) return;
        if (config.sse) { try { await openStream(user); } catch { return; } }
        activatedUsers++;
        let poll=0,roster=0,presence=0,desktop=0,files=0,write=performance.now()+1000+(user.index%10)*100,iteration=0;
        while (performance.now()<end && !signal.aborted) {
          const now=performance.now(),room=`/api/sessions/${user.roomId}`;
          if (now>=poll) {
            poll=now+config['poll-ms'];
            await request(user,'chat-tasks',`/api/tasks?sessionId=${user.roomId}&runId=${user.runId}&members=0`,{check:data=>Array.isArray(data.tasks)&&data.members.length===0});
            await request(user,'task-inbox','/api/tasks',{check:data=>Array.isArray(data.tasks)&&data.tasks.every(task=>task.assigneeId===user.id)});
          }
          if (now>=roster) {
            roster=now+15000;
            await request(user,'task-members',`/api/tasks?sessionId=${user.roomId}`,{check:data=>data.members.some(member=>member.userId===user.id)});
            await request(user,'room-members',room+'/members',{check:data=>data.members.some(member=>member.userId===user.id)});
          }
          if (now>=presence) {
            presence=now+20000;
            await request(user,'presence','/api/presence',{method:'POST',body:{connectionId:user.connectionId,sessionId:user.roomId,orgId:user.orgId},check:data=>data.online.includes(user.id)});
          }
          if (now>=desktop) {
            desktop=now+30000;
            await request(user,'device-identity','/api/runner/me',{device:true,check:data=>data.device?.userId===user.id});
            await request(user,'device-heartbeat','/api/runner/heartbeat',{method:'POST',device:true,body:{version:'2',agentIds:[],modelCatalog:[]},check:data=>data.deviceId===user.deviceId});
          }
          if (now>=files) {
            files=now+30000;
            await request(user,'file-tree',room+'/tree',{check:data=>data.files===20});
            await request(user,'file-content',room+'/file?path=src/file-0.txt',{check:data=>data.text?.startsWith('Load fixture 0')});
            await request(user,'workspace-history',room+`/runs/${user.runId}/history`,{check:data=>Array.isArray(data.turns)&&Array.isArray(data.snapshots)});
          }
          if (performance.now()>=write && performance.now()<end) {
            write=performance.now()+config['write-ms'];
            const id=randomUUID(),fresh=iteration++%5===0;
            const body={id,sessionId:user.roomId,assigneeId:user.assignee.id,body:`Load assignment ${id}`,
              ...(fresh?{newChat:{repoId:null,agentId:'codex'}}:{runId:user.runId})};
            const expectedRun=fresh?id:user.runId;
            const submission={method:'POST',body,status:201,check:data=>data.id===id&&data.runId===expectedRun};
            const first=await request(user,fresh?'create-chat-task':'create-task','/api/tasks',submission);
            const retry=await request(user,'retry-task','/api/tasks',submission);
            if (first||retry) {
              acknowledgedTasks++;
              if (await request(user.assignee,'complete-task',`/api/tasks/${id}`,{method:'PATCH',body:{status:'done'},check:data=>data.updated===true})) completedTasks++;
            }
            if (performance.now()<end) {
              const message=`${marker}:${user.index}:${iteration}:${Date.now()}`;
              if (config.sse) { pendingOwn.add(message); pendingDelivery.set(message,new Set(liveRooms.get(user.roomId))); }
              if (!await request(user,'send-message',room+'/messages',{method:'POST',body:{body:message},status:201,check:data=>data.body===message})) { pendingOwn.delete(message); pendingDelivery.delete(message); }
            }
          }
          // Sleep until this user's next operation, instead of waking every
          // 100 ms even when every deadline is several seconds away.
          await cancellableDelay(Math.max(100,Math.min(poll,roster,presence,desktop,files,write,end)-performance.now()),signal);
        }
      } catch (error) { if (!signal.aborted) throw error; }
    }));
    const failure=outcomes.find(outcome=>outcome.status==='rejected');
    if (failure) throw failure.reason;
    if (!signal.aborted && config.sse) await delay(2000); // drain deliveries already published
  } finally {
    clearInterval(progress); streamController.abort();
    detachStreams();
    await Promise.all([httpAgent.destroy(),streamAgent.destroy()]);
    const closed=await Promise.race([Promise.allSettled(streams).then(()=>true),delay(5000,false,{ref:false})]);
    if (!closed) throw new Error('Event streams did not close within five seconds.');
  }
  const stored=(await fixture.pool.query(`SELECT count(*)::int AS tasks,count(*) FILTER (WHERE status='done')::int AS done FROM room_tasks`)).rows[0];
  const turns=Number((await fixture.pool.query('SELECT count(*) AS n FROM agent_turns')).rows[0].n);
  const orphans=Number((await fixture.pool.query(`SELECT count(*) AS n FROM agent_runs r LEFT JOIN room_tasks t ON t.run_id=r.id WHERE r.title LIKE 'Load assignment %' AND t.id IS NULL`)).rows[0].n);
  return {activatedUsers,elapsedSeconds:(performance.now()-started)/1000,steadySeconds:config.duration,steadyCompletions,peakInflight,
    requests:metrics.summary(),failureExamples:metrics.failures,acknowledgedTasks,completedTasks,
    streams:{enabled:!!config.sse,peak,unexpectedDisconnects,receivedMessages:received,missingOwnMessages:pendingOwn.size,
      missingRoomDeliveries:[...pendingDelivery.values()].reduce((sum,waiting)=>sum+waiting.size,0),readyLatency:readyLatency.summary(),deliveryLatency:delivery.summary()},
    invariants:[{name:'Retries create exactly one stored task per acknowledged assignment',ok:stored.tasks===acknowledgedTasks,stored:stored.tasks,expected:acknowledgedTasks},
      {name:'Acknowledged completions are stored',ok:stored.done===completedTasks,stored:stored.done,expected:completedTasks},
      {name:'Human assignments never start AI turns',ok:turns===0,turns},
      {name:'New task chats have an associated task',ok:orphans===0,orphans}],interrupted:signal.aborted};
}
