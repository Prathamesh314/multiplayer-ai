import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compute } from './typescript/compute.ts';

test('graph traversal matches fixed overflow-sensitive vectors',()=>{
  for(const [nodes,rounds,seed,checksum,visited] of [
    [16,1,0,3233831135,16],[997,7,73,3639982739,6979],
    [20000,32,73,2122163898,502741],[25000,64,1000000,753805657,1527179],
  ])assert.deepEqual(compute({kind:'graph',nodes,rounds,seed}),{checksum,visited});
});

test('snapshot detects additions modifications and deletions without counting unchanged files',()=>{
  const result=compute({kind:'snapshot',
    base:[{path:'a',sha:'a',size:10},{path:'b',sha:'b',size:20},{path:'c',sha:'c',size:30}],
    head:[{path:'a',sha:'a',size:10},{path:'b',sha:'d',size:21},{path:'d',sha:'d',size:40}],
  });
  assert.equal(result.added,1);assert.equal(result.modified,1);assert.equal(result.deleted,1);assert.equal(result.bytes,61);
});
