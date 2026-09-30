import test from 'node:test';
import assert from 'node:assert/strict';
import { options, Histogram, Metrics, failuresFor, networkFailure } from './core.mjs';
import { connectionShards } from './transport.mjs';

test('connection shards retain the exact socket budget and fit every SSE user',()=>{
  for(const total of [1,10,64,65,1000,4096,10000]){
    const shards=connectionShards(total),assigned=shards.map(()=>0);
    for(let user=0;user<total;user++)assigned[user%shards.length]++;
    assert.deepEqual(shards,assigned);
    assert.equal(shards.reduce((a,b)=>a+b,0),total);
    assert.ok(shards.every(size=>size>0&&size<=64));
  }
});

test('profiles require explicit large-load selection and reject misspelled or unbounded settings',()=>{
  assert.equal(options([]).users,10);
  assert.equal(options(['--profile','1000','--duration=30']).users,1000);
  assert.equal(options(['--profile=1000','--users=20']).users,20);
  assert.equal(options(['--profile=10000']).users,10000);
  assert.equal(options(['--profile=10000']).ramp,120);
  assert.equal(options(['--users=10000']).users,10000);
  assert.equal(options(['--http-connections=1000'])['http-connections'],1000);
  assert.equal(options(['--workers=4']).workers,4);
  assert.throws(()=>options(['--workers=0']));
  assert.throws(()=>options(['--workers=9']));
  assert.throws(()=>options(['--http-connections=0']));
  assert.throws(()=>options(['--http-connections=4097']));
  for (const args of [['--users=0'],['--users=10001'],['--users'],['--users=1.5'],['--duration=Infinity'],['--profile=oops'],['--user=1000'],['--sse=2']]) assert.throws(()=>options(args));
});
test('percentiles are bounded approximations and do not retain individual samples',()=>{
  const h=new Histogram(); assert.equal(h.summary().p95Ms,null);
  for(let n=1;n<=10000;n++) h.add(n);
  assert.equal(h.count,10000);assert.ok(h.bins.size<1000);
  assert.ok(h.percentile(.95)>=9500 && h.percentile(.95)<=9596);
  assert.equal(h.summary().maxMs,10000);
  assert.throws(()=>h.add(NaN));
});
test('errors include failed status and semantic checks, separately from latency',()=>{
  const metrics=new Metrics();metrics.record('steady','tasks',10,true,'200');metrics.record('steady','tasks',20,false,'200 invalid-body');
  assert.equal(metrics.summary()[0].errorRate,.5);
  assert.equal(metrics.summary()[0].successfulLatency.count,1);
  assert.equal(metrics.summary()[0].successfulLatency.maxMs,10);
  const report={requests:metrics.summary(),activatedUsers:10,streams:{peak:10,unexpectedDisconnects:0,missingOwnMessages:0},invariants:[{ok:true}]};
  assert.match(failuresFor(report,options([])).join(' '),/error rate/);
  report.requests=[];assert.match(failuresFor(report,options([])).join(' '),/No steady-state/);
});

test('transport diagnostics retain codes without recording error messages or credentials',()=>{
  assert.equal(networkFailure({cause:{code:'ECONNRESET'}}),'network:ECONNRESET');
  assert.equal(networkFailure({cause:{code:'https://secret@example.test'}}),'network:unknown');
  assert.equal(networkFailure({message:'token secret'}),'network:unknown');
});
test('missing users, missing live deliveries, failed invariants and interrupts fail the run',()=>{
  const report={requests:[{phase:'steady',operation:'tasks',errorRate:0,p95Ms:10}],activatedUsers:9,
    streams:{peak:9,unexpectedDisconnects:1,missingOwnMessages:1},invariants:[{ok:false}],interrupted:true};
  assert.equal(failuresFor(report,options([])).length,4);
});

test('ramp failures and missing fanout cannot be hidden by successful steady requests or own messages',()=>{
  const report={requests:[{phase:'ramp',operation:'tasks',count:2,failed:1,errorRate:.5,p95Ms:5},
    {phase:'steady',operation:'tasks',count:2,failed:0,errorRate:0,p95Ms:5}],activatedUsers:10,
    streams:{peak:10,unexpectedDisconnects:0,missingOwnMessages:0,missingRoomDeliveries:1,deliveryLatency:{p95Ms:2000}},invariants:[{ok:true}]};
  const reasons=failuresFor(report,options([]));
  assert.equal(reasons.length,3);
  assert.match(reasons.join(' '),/including ramp-up/);
  assert.match(reasons.join(' '),/message-delivery/);
  assert.match(reasons.join(' '),/event-delivery p95/);
});
