import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexSession } from '../runner/codex-session.ts';
import { WakeSignal, readSignals } from '../runner/signals.ts';
import { sharedStream } from '../app/lib/events/shared-client.ts';
import { createRedisBus } from '../app/lib/events/redis.ts';
import { eventResponse } from '../app/lib/events/response.ts';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('remembered wakeups cannot be lost between checking work and waiting', async () => {
  const wake = new WakeSignal(), before = wake.version();
  wake.wake(); await wake.wait(before);
  const abort = new AbortController(); const waiting = wake.wait(wake.version(), abort.signal); abort.abort(); await waiting;
});

test('split SSE signals are decoded without treating keepalives as work', async () => {
  const encoder = new TextEncoder();
  const pieces = [': keepalive\n\nevent: run.', 'inputs\ndata: {"runId":"x"}\n', '\nevent: ready\ndata: {}\n\n'];
  const response = new Response(new ReadableStream({ start(c) { for (const text of pieces) c.enqueue(encoder.encode(text)); c.close(); } }));
  const received = []; await readSignals(response, (type, data) => received.push([type,data]));
  assert.deepEqual(received, [['run.inputs',{runId:'x'}],['ready',{}]]);
});

test('many UI subscribers share one connection, reconnect refreshes and last close releases it', () => {
  const original = globalThis.EventSource; const created = [];
  class FakeSource {
    handlers = new Map(); closed = false;
    constructor(url) { this.url = url; created.push(this); }
    addEventListener(type, listener) { this.handlers.set(type,listener); }
    emit(type, data={}) { this.handlers.get(type)?.({data:JSON.stringify(data)}); }
    close() { this.closed = true; }
  }
  globalThis.EventSource = FakeSource;
  try {
    let a=0,b=0,ready=0;
    const first=sharedStream('/test-room',{event:()=>a++,status:state=>{if(state)ready++;}});
    const second=sharedStream('/test-room',{event:()=>b++});
    assert.equal(created.length,1);
    const source=created[0];source.emit('ready');source.emit('tasks.changed');source.onerror();source.emit('ready');source.emit('resync');
    assert.deepEqual([a,b,ready],[1,1,3]);
    first.close();source.emit('tasks.changed');assert.equal(source.closed,false);assert.equal(b,2);
    second.close();second.close();assert.equal(source.closed,true);
  } finally {globalThis.EventSource=original;}
});

test('Redis subscribe/unsubscribe races keep the new subscriber connected', async () => {
  let handler, subscribed=0,unsubscribed=0;
  const subscriber={ async subscribe(_c,fn){await pause(5);handler=fn;subscribed++;},async unsubscribe(){await pause(5);handler=null;unsubscribed++;},async quit(){} };
  const bus=createRedisBus({async publish(){}},subscriber);let deliveries=0;
  const [offA,offB]=await Promise.all([bus.subscribe('room',()=>deliveries++),bus.subscribe('room',()=>deliveries++)]);
  assert.equal(subscribed,1);handler(JSON.stringify({type:'resync',at:0}));assert.equal(deliveries,2);
  await offA(); const closing=offB();const opening=bus.subscribe('room',()=>deliveries++);
  await closing;const offC=await opening;handler(JSON.stringify({type:'resync',at:0}));assert.equal(deliveries,3);
  await offC();assert.equal(unsubscribed,2);await bus.close();
});

test('SSE cancellation while subscription is connecting still unsubscribes', async () => {
  let finish,off=0;const controller=new AbortController();
  const response=eventResponse(new Request('http://test/events',{signal:controller.signal}),async()=>{await new Promise(resolve=>{finish=resolve;});return async()=>{off++;};});
  controller.abort();finish();await pause(1);assert.equal(off,1);
  assert.equal((await response.body.getReader().read()).done,true);
});

test('content-bearing SSE rechecks permission before delivery and fails closed', async () => {
  let send, allowed=true, off=0;
  const response=eventResponse(new Request('http://test/events'),async listener=>{
    send=listener;return async()=>{off++;};
  },{validateEvents:true,validate:async()=>allowed});
  const reader=response.body.getReader();
  await reader.read(); // ready
  send({type:'chat.message',conversationId:'x',message:{body:'allowed'},at:0});
  assert.match(new TextDecoder().decode((await reader.read()).value),/allowed/);
  allowed=false;
  send({type:'chat.message',conversationId:'x',message:{body:'secret after revocation'},at:0});
  assert.equal((await reader.read()).done,true);
  assert.equal(off,1);
});

test('authorization backlog is bounded when a chat client cannot keep up', async () => {
  let send, off=0;
  const response=eventResponse(new Request('http://test/events'),async listener=>{
    send=listener;return async()=>{off++;};
  },{validateEvents:true,validate:async()=>true});
  const reader=response.body.getReader();await reader.read();
  for(let i=0;i<100;i++)send({type:'resync',at:i});
  assert.equal((await reader.read()).done,true);
  assert.equal(off,1);
});

async function fixture(t, mode) {
  const directory=await mkdtemp(join(tmpdir(),'mp-codex-live-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const bin=join(directory,'fake-codex');
  await writeFile(bin,`#!${process.execPath}
const readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let turns=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
const q=JSON.parse(line); const reply=result=>send({id:q.id,result});
if(q.method==='initialize')return reply({});
if(q.method==='thread/start') {
 if(q.params.sandbox!=='workspace-write'||q.params.approvalPolicy!=='never')process.exit(9);
 return reply({thread:{id:'thread'}});
}
if(q.method==='turn/start'){
 const id='turn-'+(++turns);reply({turn:{id}});
 if(turns===1&&${JSON.stringify(mode)}!=='boundary')send({method:'item/started',params:{item:{type:'commandExecution',command:'reading files'}}});
 else {send({method:'item/agentMessage/delta',params:{delta:'done '+turns}});send({method:'turn/completed',params:{turn:{id,status:'completed'}}});}
}
if(q.method==='turn/steer'){
 if(${JSON.stringify(mode)}==='boundary')return send({id:q.id,error:{message:'no active turn'}});
 if(q.params.expectedTurnId!=='turn-1'||q.params.input[0].text!=='Also test keyboard controls')process.exit(8);
 if(${JSON.stringify(mode)}==='disconnect')return process.exit(0);
 reply({turnId:'turn-1'});
 send({method:'item/agentMessage/delta',params:{delta:'Steered without restarting'}});
 send({method:'turn/completed',params:{turn:{id:'turn-1',status:'completed'}}});
}
});
`);await chmod(bin,0o755);return {directory,bin};
}
for(const mode of ['live','boundary','disconnect'])test(`Codex ${mode}: queued input uses native protocol and never silently replays`,{timeout:10000},async t=>{
  const {directory,bin}=await fixture(t,mode);const wake=new WakeSignal();const queued=[];const accepted=[],uncertain=[],claims=[];let started=false;
  if(mode==='boundary')queued.push({id:'one',body:'Also test keyboard controls'});
  const result=await runCodexSession({spec:{id:'codex',bin},cwd:directory,prompt:'Initial instruction',onEvent:event=>{
    if(event.t==='act'&&!started){started=true;queued.push({id:'one',body:'Also test keyboard controls'});wake.wake();}
  },inputs:{subscribe:fn=>wake.subscribe(fn),claim:async close=>{claims.push(close);return queued.shift()??null;},acknowledge:async id=>accepted.push(id),uncertain:async id=>uncertain.push(id)}});
  if(mode==='disconnect'){assert.equal(result.code,1);assert.deepEqual(accepted,[]);assert.deepEqual(uncertain,['one']);}
  else {assert.equal(result.code,0);assert.deepEqual(accepted,['one']);assert.equal(claims.at(-1),true);assert.match(result.output,mode==='live'?/Steered without restarting/:/done 2/);}
});

test('one-shot providers drain queued messages in order after each process exits', {timeout:10000}, async () => {
  const {runAgentLocally}=await import('../runner/execute.ts');
  const pending=[{id:'first',body:'First queued instruction'},{id:'second',body:'Second queued instruction'}], accepted=[];
  const prompts=[];
  const result=await runAgentLocally({spec:{id:'gemini',bin:process.execPath,models:[{id:'',label:'Default'}],efforts:[],promptArgs:prompt=>{
    prompts.push(prompt);return ['-e','setTimeout(()=>process.stdout.write("Response"),10)'];
  }},cwd:tmpdir(),prompt:'Original instruction',onEvent:()=>{},inputs:{claim:async()=>pending.shift()??null,acknowledge:async id=>accepted.push(id),uncertain:async()=>assert.fail('unexpected uncertain delivery'),subscribe:()=>()=>{}}});
  assert.equal(result.code,0);assert.deepEqual(accepted,['first','second']);assert.equal(prompts.length,3);
  assert.match(prompts[1],/First queued instruction/);assert.match(prompts[2],/Second queued instruction/);assert.match(prompts[2],/First queued instruction/);
});

test('queue failure preserves completed CLI output for finalization', async () => {
  const {runAgentLocally}=await import('../runner/execute.ts');
  const result=await runAgentLocally({spec:{id:'gemini',bin:process.execPath,models:[{id:'',label:'Default'}],efforts:[],promptArgs:()=>['-e','process.stdout.write("Completed work before disconnect")']},cwd:tmpdir(),prompt:'Work',onEvent:()=>{},inputs:{claim:async()=>{throw new Error('Queue connection failed');},acknowledge:async()=>{},uncertain:async()=>{},subscribe:()=>()=>{}}});
  assert.equal(result.code,1);assert.match(result.output,/Completed work before disconnect/);assert.match(result.errOutput,/Queue connection failed/);
});
