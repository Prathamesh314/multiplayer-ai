import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import nextEnv from '@next/env';
import {remember,recall} from '../app/lib/ai/mnemosyne.ts';

nextEnv.loadEnvConfig(process.cwd(),true);
assert.ok(process.env.MNEMOSYNE_URL,'Configure MNEMOSYNE_URL before this opt-in live test');
const marker=`demo-memory-${randomUUID()}`, bank=marker, other=`${marker}-other`;
const content=`Readiness fixture ${marker}: our release decision is to use cedar blue for the demo.`;
const headers={'content-type':'application/json',accept:'application/json, text/event-stream',
  ...(process.env.MNEMOSYNE_MCP_TOKEN?{authorization:`Bearer ${process.env.MNEMOSYNE_MCP_TOKEN}`}:{})};
let sequence=0;
async function rpc(method,params,notification=false) {
  const response=await fetch(process.env.MNEMOSYNE_URL,{method:'POST',headers,
    body:JSON.stringify({jsonrpc:'2.0',...(!notification?{id:++sequence}:{}),method,params}),signal:AbortSignal.timeout(120_000)});
  assert.ok(response.ok,`MCP ${method}: HTTP ${response.status}`);
  if(response.headers.has('mcp-session-id')) headers['mcp-session-id']=response.headers.get('mcp-session-id');
  const text=await response.text();
  const payload=text?(response.headers.get('content-type')?.includes('text/event-stream')
    ?JSON.parse(text.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5)).join('')):JSON.parse(text)):null;
  assert.ok(!payload?.error,'MCP request must succeed');return payload?.result;
}
async function tool(name,args) {
  const result=await rpc('tools/call',{name,arguments:args});
  assert.ok(!result?.isError,`${name} failed`);
  return result.structuredContent??JSON.parse(result.content.find(part=>part.type==='text').text);
}
await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'isolated-memory-readiness',version:'1'}});
await rpc('notifications/initialized',{},true);
try {
  assert.equal(await remember({bank,content,importance:0.7,channelId:marker,source:'readiness-fixture',timeoutMs:120_000}),true);
  const own=await recall({bank,query:marker,topK:5});
  assert.ok(own.some(item=>item.content===content),'App must recall its stored fixture');
  const foreign=await tool('mnemosyne_recall',{bank:other,query:marker,top_k:5});
  assert.equal(foreign.bank,other,'Service must acknowledge the requested bank');
  assert.deepEqual(foreign.results,[],'A different bank must not see the fixture');
  console.log('Live memory passed: app write/read and explicit cross-bank isolation.');
} finally {
  const stored=await tool('mnemosyne_recall',{bank,query:marker,top_k:5});
  assert.equal(stored.bank,bank,'Only clean up the isolated test bank');
  for(const item of stored.results??[]) if(item.content===content) {
    const id=item.id??item.memory_id;assert.ok(id,'Cleanup needs the exact synthetic memory ID');
    await tool('mnemosyne_forget',{bank,memory_id:id});
  }
  const after=await tool('mnemosyne_recall',{bank,query:marker,top_k:5});
  assert.ok(!after.results?.some(item=>item.content===content),'Synthetic memory must be removed');
  console.log('Synthetic memory removed. Existing conversation banks were untouched.');
}
