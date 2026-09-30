import test from 'node:test';
import assert from 'node:assert/strict';
import {GitReadCache,cachedGitRead} from '../app/lib/git/read-cache.ts';

test('concurrent readers share work, receive independent buffers, and retry failures',async()=>{
  const cache=new GitReadCache(); let calls=0;
  const load=async()=>{calls++;return Buffer.from('original');};
  const values=await Promise.all(Array.from({length:10},()=>cache.read('a',load)));
  assert.equal(calls,1); values[0].fill(0);
  assert.equal(values[1].toString(),'original'); assert.equal((await cache.read('a',load)).toString(),'original');
  await assert.rejects(cache.read('failure',async()=>{throw new Error('temporary');}));
  assert.equal((await cache.read('failure',load)).toString(),'original');
});
test('byte, entry and individual-object budgets evict or bypass storage',async()=>{
  const cache=new GitReadCache(6,2,4);let calls=0;
  const read=(key,value)=>cache.read(key,async()=>{calls++;return Buffer.from(value);});
  await read('a','aaa');await read('b','bbb');await read('a','aaa');await read('c','ccc');
  assert.equal(calls,3);await read('b','bbb');assert.equal(calls,4);
  await read('large','12345');await read('large','12345');assert.equal(calls,6);
  const empty=new GitReadCache(6,1,4);let emptyCalls=0;
  const load=async()=>{emptyCalls++;return Buffer.alloc(0);};
  await empty.read('a',load);await empty.read('b',load);await empty.read('a',load);assert.equal(emptyCalls,3);
});
test('repository, commit and path isolation; moving references always bypass the cache',async()=>{
  let calls=0;const load=async()=>Buffer.from(String(++calls));
  const sha='a'.repeat(40),other='b'.repeat(40),repo='/test/read-cache';
  await cachedGitRead(repo,sha,'file:a',load);await cachedGitRead(repo,sha,'file:a',load);assert.equal(calls,1);
  await cachedGitRead(repo,other,'file:a',load);await cachedGitRead(repo,sha,'file:b',load);
  await cachedGitRead(repo+'-other',sha,'file:a',load);assert.equal(calls,4);
  await cachedGitRead(repo,'main','file:a',load);await cachedGitRead(repo,'main','file:a',load);assert.equal(calls,6);
});
