import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFileLock, createMemoryLock, inheritedRepoLocks, repoLock } from '../app/lib/session/lock.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(),'mp-kernel-lock-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  return directory;
}
function child(t,directory,mode='wait') {
  const process = fork(new URL('./helpers/lock-process.mjs',import.meta.url),[directory,mode],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
  let stderr=''; process.stderr.on('data', chunk=>{stderr+=chunk;});
  t.after(()=>{if(process.exitCode===null && !process.signalCode)process.kill('SIGKILL');});
  return {process, error:()=>stderr};
}
test('same repository serializes independent file-lock instances; nested calls do not deadlock',async t=>{
  const directory=await fixture(t), one=createFileLock({directory}), two=createFileLock({directory});
  const log=[];
  await Promise.all([
    one.withLock('a',async()=>{log.push('a'); await one.withLock('a',async()=>{await delay(80);});log.push('b');}),
    two.withLock('a',async()=>{log.push('c');}),
  ]);
  // flock promises exclusion, not FIFO scheduling between independent opens.
  assert.ok(['abc','cab'].includes(log.join('')), 'a/b must remain contiguous while the nested lock is held');
  await assert.rejects(one.withLock('a',async()=>{throw new Error('failed mutation');}),/failed mutation/);
  assert.equal(await two.withLock('a',async()=>42),42);
});
test('different repositories can proceed concurrently',async t=>{
  const directory=await fixture(t), lock=createFileLock({directory});
  await lock.withLock('a',()=>lock.withLock('b',async()=>assert.equal(inheritedRepoLocks().length,2)));
});
test('stopped process keeps ownership; killing it releases the lock without stale-file deletion',async t=>{
  const directory=await fixture(t), holder=child(t,directory);
  assert.equal((await once(holder.process,'message'))[0],'locked',holder.error());
  holder.process.kill('SIGSTOP');
  const contender=createFileLock({directory,acquireTimeoutMs:100});
  await assert.rejects(contender.withLock('repository',async()=>assert.fail('overlapping writer')),/busy/);
  const exited=once(holder.process,'exit');holder.process.kill('SIGKILL');await exited;
  assert.equal(await contender.withLock('repository',async()=>42),42);
});
test('real Git subprocess retains ownership after parent SIGKILL',async t=>{
  const directory=await fixture(t), holder=child(t,directory,'git');
  const deadline=Date.now()+5000;
  while(!await stat(join(directory,'git-started')).catch(()=>null)){
    assert.ok(Date.now()<deadline,holder.error()||'Git did not start');await delay(20);
  }
  const exited=once(holder.process,'exit');holder.process.kill('SIGKILL');await exited;
  await assert.rejects(createFileLock({directory,acquireTimeoutMs:100}).withLock('repository',async()=>assert.fail('Git was still writing')),/busy/);
  await createFileLock({directory,acquireTimeoutMs:4000}).withLock('repository',async()=>{
    assert.ok(await stat(join(directory,'git-finished')));
  });
});
test('missing lock helper fails closed; escaped callbacks cannot reuse released descriptors',async t=>{
  const directory=await fixture(t);
  await assert.rejects(createFileLock({directory,python:join(directory,'missing')}).withLock('a',async()=>assert.fail('unsafe fallback')));
  let runLater, escaped;
  await createFileLock({directory}).withLock('a',async()=>{
    escaped=new Promise(resolve=>{runLater=resolve;}).then(()=>assert.throws(inheritedRepoLocks,/outlived/));
  });
  runLater();await escaped;
});
test('in-memory utility still serializes and recovers after a rejected task',async()=>{
  const lock=createMemoryLock(), log=[];
  await Promise.all([lock.withLock('x',async()=>{log.push(1);await delay(10);log.push(2);}),lock.withLock('x',async()=>log.push(3))]);
  assert.deepEqual(log,[1,2,3]);
});

test('hot reload cannot silently retain the old expiring lock driver',()=>{
  globalThis.__maRepoLock=Promise.resolve(createMemoryLock());
  try {assert.throws(repoLock,/Restart all web and worker/);}
  finally {delete globalThis.__maRepoLock;}
});
