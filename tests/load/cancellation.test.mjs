import test from 'node:test';import assert from 'node:assert/strict';
import {getEventListeners}from'node:events';
import {setTimeout as delay}from'node:timers/promises';
import {requestCancellation,cancellableDelay}from'./cancellation.mjs';
test('completed requests leave no parent listeners or live timeout',async()=>{
  const parent=new AbortController();
  for(let n=0;n<10000;n++){
    const c=requestCancellation(parent.signal,60000);
    assert.equal(getEventListeners(parent.signal,'abort').length,1);c.dispose();
  }
  assert.equal(getEventListeners(parent.signal,'abort').length,0);
  const done=requestCancellation(parent.signal,1);done.dispose();await delay(10);assert.equal(done.signal.aborted,false);
});
test('concurrent requests and timers use one parent listener and cancel together',async()=>{
  const parent=new AbortController();
  const requests=Array.from({length:10000},()=>requestCancellation(parent.signal,60000));
  const waiting=cancellableDelay(60000,parent.signal);
  assert.equal(getEventListeners(parent.signal,'abort').length,1);
  parent.abort();await assert.rejects(waiting);
  assert.ok(requests.every(request=>request.signal.aborted));
  requests.forEach(request=>request.dispose());
  assert.equal(getEventListeners(parent.signal,'abort').length,0);
  await assert.rejects(cancellableDelay(60000,parent.signal));
});
test('deadlines and global cancellation still interrupt active requests',async()=>{
  const parent=new AbortController(),active=requestCancellation(parent.signal,60000);
  parent.abort();assert.equal(active.signal.aborted,true);assert.equal(active.timedOut(),false);active.dispose();
  const late=requestCancellation(parent.signal,60000);assert.equal(late.signal.aborted,true);late.dispose();
  const timeout=requestCancellation(new AbortController().signal,1);await delay(10);
  assert.equal(timeout.signal.reason.name,'TimeoutError');assert.equal(timeout.timedOut(),true);timeout.dispose();
});
