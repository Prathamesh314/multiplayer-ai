import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createMemory, transitionMemory, listMemories, recordExchange } from "../app/lib/knowledge/memory-records.ts";
import { processMemoryJob, indexContent } from "../app/lib/knowledge/memory-jobs.ts";
import { enqueueMemoryJob } from "../app/lib/knowledge/memory-records.ts";
import { migrate } from "../db/migrate.mjs";
import { recallMemories } from "../app/lib/knowledge/memory-retrieval.ts";
import { addMemoryEdge, memoryGraph } from "../app/lib/knowledge/memory-edges.ts";
import { validateClaims, extractClaims } from "../app/lib/knowledge/memory-extraction.ts";
import { transaction } from "../app/lib/db/client.ts";
import { finalizeAgentRun } from "../app/lib/ai/finalize.ts";
import { buildKnowledgeContext } from "../app/lib/knowledge/index.ts";
import { remember } from "../app/lib/ai/mnemosyne.ts";

const f = await memoryFixture();
const {db,first,room,other,secret,alice,bob,outsider,message,exchange} = f;
let passed=0;
const test=async(name,fn)=>{ await fn();passed++;console.log(`  ok ${name}`); };
const approve = m => transitionMemory(m.room_id,alice,m.id,{status:'approved',revision:m.revision});
const recall = (prompt,extra={},search) => recallMemories({roomIds:[room,other,secret],userId:alice,prompt,...extra},search);
const fact = async (text,scope=room) => createMemory(scope,alice,{kind:'fact',text,sourceMessageId:await message(text,scope)});
const ready = async id => db.query(`UPDATE memory_jobs SET retry_at=now(),lease_id=NULL,lease_until=NULL WHERE memory_id=$1`,[id]);
// Hold unrelated jobs out of individual fault-injection cases.
const hold = () => db.query(`UPDATE memory_jobs SET retry_at=now()+interval '1 day'`);
try {
  let episode;
  await test('successful exchange and jobs are durable without Mnemosyne; replay is idempotent',async()=>{
    episode=await exchange();
    assert.equal(episode.status,'approved');
    assert.equal(episode.source_run_id,episode.input.runId);
    assert.equal(episode.source_turn_id,episode.input.turnId);
    assert.equal(episode.stated_by,alice);
    assert.equal(episode.org_id,f.org);
    assert.equal((await first(`SELECT count(*)::int n FROM memory_jobs WHERE memory_id=$1`,[episode.id])).n,2);
    await transaction(tx=>recordExchange(tx,episode.input));
    assert.equal((await first(`SELECT count(*)::int n FROM memory_records WHERE source_turn_id=$1`,[episode.source_turn_id])).n,1);
  });
  await test('completion cannot commit without its memory and outbox; retry does not duplicate replies',async()=>{
    const run=(await first(`INSERT INTO agent_runs(session_id,started_by,agent_id,base_sha,status) VALUES ($1,$2,'codex',$3,'running') RETURNING id`,[room,alice,'a'.repeat(40)])).id;
    const turn=randomUUID();
    await db.query(`INSERT INTO agent_turns(id,run_id,driver_user_id,control_version,status) VALUES ($1,$2,$3,0,'running')`,[turn,run,alice]);
    const input={turnId:turn,runId:run,sessionId:room,repoId:null,baseSha:'a'.repeat(40),userPrompt:'Explain atomic memory',binName:'test',author:{name:'Alice'},sha:null,code:0,output:'Atomic memory is durable.',errOutput:''};
    const pool=globalThis.__maPool,connect=pool.connect;
    pool.connect=async()=>{const c=await connect();return {...c,query(sql,params){if(sql.includes('INSERT INTO memory_records')) throw new Error('injected memory failure');return c.query(sql,params);}};};
    try {await assert.rejects(finalizeAgentRun(input),/injected memory failure/);} finally {pool.connect=connect;}
    assert.equal((await first(`SELECT status FROM agent_turns WHERE id=$1`,[turn])).status,'running');
    assert.equal((await first(`SELECT count(*)::int n FROM agent_run_messages WHERE run_id=$1`,[run])).n,0);
    await finalizeAgentRun(input); await finalizeAgentRun(input);
    assert.equal((await first(`SELECT count(*)::int n FROM agent_run_messages WHERE run_id=$1`,[run])).n,1);
    assert.equal((await first(`SELECT count(*)::int n FROM memory_records WHERE source_turn_id=$1`,[turn])).n,1);
  });
  let gated,gatedClaim;
  await test('project code remains proposed and cannot be approved before publication',async()=>{
    gated=await exchange({sha:'b'.repeat(40),reply:'Implemented durable retry handling.'});
    assert.equal(gated.status,'proposed');
    await assert.rejects(approve(gated),/Publish/);
    gatedClaim=await createMemory(room,alice,{kind:'fact',text:'Durable retry handling is implemented.',sourceMemoryId:gated.id});
    await assert.rejects(approve(gatedClaim),/Publish/);
    assert.ok(!(await recall('durable retry handling')).records.some(m=>m.id===gated.id));
    assert.equal((await first(`SELECT count(*)::int n FROM memory_edges WHERE from_id=$1`,[gated.id])).n,2);
    await hold();await ready(gated.id);
    await processMemoryJob({published:async()=>false});
    assert.equal((await first(`SELECT status FROM memory_records WHERE id=$1`,[gated.id])).status,'proposed');
    assert.ok((await first(`SELECT last_error FROM memory_jobs WHERE memory_id=$1 AND operation='publish'`,[gated.id])).last_error);
  });
  await test('publication recovery approves exact source episodes and queues delivery',async()=>{
    await ready(gated.id); await processMemoryJob({published:async m=>m.commit_sha==='b'.repeat(40)});
    gated=await first(`SELECT * FROM memory_records WHERE id=$1`,[gated.id]);
    assert.equal(gated.status,'approved');assert.ok(gated.published_at);
    const child=await first(`SELECT * FROM memory_records WHERE id=$1`,[gatedClaim.id]);
    assert.equal(child.status,'proposed');assert.ok(child.published_at);
    assert.equal((await first(`SELECT count(*)::int n FROM memory_jobs WHERE memory_id=$1 AND operation='index'`,[gated.id])).n,1);
  });
  await test('failed sidecar writes remain queued with retry information',async()=>{
    await hold();await ready(episode.id);
    await processMemoryJob({index:async()=>false});
    const job=await first(`SELECT * FROM memory_jobs WHERE memory_id=$1 AND operation='index'`,[episode.id]);
    assert.equal(job.attempts,1);assert.ok(job.last_error);assert.equal(job.lease_id,null);
    assert.ok((await recall('retry policy')).records.some(m=>m.id===episode.id));
    await ready(episode.id);await processMemoryJob({index:async()=>true});
    assert.equal(await first(`SELECT * FROM memory_jobs WHERE memory_id=$1 AND operation='index'`,[episode.id]),undefined);
  });
  await test('expired worker leases are reclaimed; active leases are not stolen',async()=>{
    await hold();await ready(gated.id);
    await db.query(`UPDATE memory_jobs SET lease_id=$2,lease_until=now()+interval '1 minute' WHERE memory_id=$1`,[gated.id,randomUUID()]);
    assert.equal(await processMemoryJob({index:async()=>{throw new Error('must not run');}}),false);
    await db.query(`UPDATE memory_jobs SET lease_until=now()-interval '1 second' WHERE memory_id=$1`,[gated.id]);
    assert.equal(await processMemoryJob({index:async()=>true}),true);
  });
  await test('one exchange yields multiple evidence-backed proposals; extraction replay deduplicates',async()=>{
    await hold();await ready(episode.id);
    const claims=[{kind:'fact',text:'Retry policy allows three attempts.',evidenceQuote:'Retry policy allows three attempts.'},
      {kind:'procedure',text:'Follow the retry policy of three attempts.',evidenceQuote:'Retry policy allows three attempts.'}];
    await processMemoryJob({extract:async()=>claims});
    let children=(await db.query(`SELECT * FROM memory_records WHERE parent_id=$1`,[episode.id])).rows;
    assert.equal(children.length,2);assert.ok(children.every(m=>m.status==='proposed'));
    assert.ok(!(await recall('three attempts')).records.some(m=>children.some(c=>c.id===m.id)));
    await db.query(`INSERT INTO memory_jobs(memory_id,operation,revision) VALUES ($1,'extract',$2)`,[episode.id,episode.revision]);
    await processMemoryJob({extract:async()=>claims});
    children=(await db.query(`SELECT * FROM memory_records WHERE parent_id=$1`,[episode.id])).rows;assert.equal(children.length,2);
  });
  await test('ungrounded extraction retries without creating claims or changing approval',async()=>{
    await hold();await ready(gated.id);
    await processMemoryJob({extract:async()=>[{kind:'fact',text:'Invented!',evidenceQuote:'not found in this source'}]});
    assert.deepEqual((await db.query(`SELECT id FROM memory_records WHERE parent_id=$1`,[gated.id])).rows.map(row=>row.id),[gatedClaim.id]);
    assert.ok((await first(`SELECT last_error FROM memory_jobs WHERE memory_id=$1 AND operation='extract'`,[gated.id])).last_error);
    assert.throws(()=>validateClaims({memories:[{kind:'fact',text:'X',evidenceQuote:'bad'}]},episode.text));
  });
  let old,current;
  await test('approval and supersession are atomic and preserve a queryable audit trail',async()=>{
    old=await approve(await fact('Use legacy policy zephyr with three retries.'));
    const replacement=await fact('Use exponential backoff with five retries.');
    current=await transitionMemory(room,alice,replacement.id,{status:'approved',revision:1,supersedes:old.id});
    const prior=await first(`SELECT * FROM memory_records WHERE id=$1`,[old.id]);
    assert.equal(prior.status,'superseded');assert.ok(prior.valid_to);
    const hits=await recall('zephyr');assert.ok(hits.records.some(m=>m.id===current.id));assert.ok(!hits.records.some(m=>m.id===old.id));
    const graph=await memoryGraph(room,alice,old.id);
    assert.ok(graph.nodes.some(m=>m.id===current.id));assert.ok(graph.edges.some(e=>e.relation==='supersedes'));
    assert.ok(graph.events.some(e=>e.to_status==='superseded'));
    await assert.rejects(transitionMemory(room,alice,current.id,{status:'retracted',revision:1}),/changed/);
  });
  await test('two replacements cannot both supersede the same current decision',async()=>{
    const target=await approve(await fact('Race policy starts here.'));
    const a=await fact('Race winner A.'),b=await fact('Race winner B.');
    const results=await Promise.allSettled([a,b].map(m=>transitionMemory(room,alice,m.id,{status:'approved',revision:1,supersedes:target.id})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await first(`SELECT count(*)::int n FROM memory_edges WHERE to_memory_id=$1 AND relation='supersedes'`,[target.id])).n,1);
  });
  await test('semantic search for an old decision follows its former approved projection to the replacement',async()=>{
    const hits=await recall('an unrelated semantic paraphrase',{},async()=>[{content:indexContent(old),score:1,importance:1,bank:'fake'}]);
    assert.ok(hits.records.some(m=>m.id===current.id));
    assert.ok(!hits.records.some(m=>m.id===old.id));
  });
  await test('an in-flight delivery cannot acknowledge a newer revision of the same job',async()=>{
    const m=await approve(await fact('Delivery revision fence.'));
    await hold();await ready(m.id);
    await processMemoryJob({index:async()=>{
      await transaction(tx=>enqueueMemoryJob(tx,{id:m.id,revision:m.revision+1},'index'));
      return true;
    }});
    const job=await first(`SELECT * FROM memory_jobs WHERE memory_id=$1 AND operation='index'`,[m.id]);
    assert.equal(job.revision,m.revision+1);assert.equal(job.lease_id,null);
  });
  await test('deleting old decision evidence does not cascade into its independently sourced replacement',async()=>{
    const prior=await approve(await fact('Original retention policy.'));
    const proposed=await fact('New retention policy.');
    const replacement=await transitionMemory(room,alice,proposed.id,{status:'approved',revision:1,supersedes:prior.id});
    await db.query(`DELETE FROM session_messages WHERE id=$1`,[prior.source_message_id]);
    const surviving=await first(`SELECT * FROM memory_records WHERE id=$1`,[replacement.id]);
    assert.equal(surviving.status,'approved');assert.equal(surviving.supersedes,null);
  });
  await test('stale, forged and private sidecar hits are never injected into prompts',async()=>{
    const privateRecord=(await first(`INSERT INTO memory_records(room_id,kind,text,source_message_id,dedupe_key,status)
      VALUES ($1,'fact','Private secret', $2,'private-test','approved') RETURNING *`,[secret,await message('Private secret',secret,outsider)]));
    const results=await recall('semantic paraphrase',{},async()=>[
      {content:indexContent({...current,text:'FORGED CONTENT'}),score:1,importance:1,bank:'fake'},
      {content:indexContent(privateRecord),score:1,importance:1,bank:'fake'},
      {content:indexContent({...old,revision:999}),score:1,importance:1,bank:'fake'},
      {content:'Legacy canonical fact without evidence',score:1,importance:1,bank:'fake'},
    ]);
    assert.ok(results.records.some(m=>m.id===current.id));
    assert.ok(!results.text.includes('FORGED'));assert.ok(!results.text.includes('Private'));assert.ok(!results.text.includes('Legacy canonical'));
    assert.deepEqual((await recall('retry',{userId:outsider,roomIds:[room]})).records,[]);
  });
  await test('revocation during semantic lookup is honored by the final SQL read',async()=>{
    const hits=await recall('semantic paraphrase',{userId:bob,roomIds:[room]},async()=>{
      await db.query(`UPDATE project_members SET removed_at=now() WHERE project_id=$1 AND user_id=$2`,[f.project,bob]);
      return [{content:indexContent(current),score:1,importance:1,bank:'fake'}];
    });
    assert.equal(hits.text,null);
    await db.query(`UPDATE project_members SET removed_at=NULL WHERE project_id=$1 AND user_id=$2`,[f.project,bob]);
  });
  await test('source edits immediately hide stale memories, including sidecar matches',async()=>{
    const m=await approve(await fact('Editable source evidence.'));
    await db.query(`UPDATE session_messages SET body='Corrected evidence',edited_at=now() WHERE id=$1`,[m.source_message_id]);
    assert.ok(!(await recall('editable',{},async()=>[{content:indexContent(m),score:1,importance:1,bank:'fake'}])).records.some(x=>x.id===m.id));
    assert.ok(!(await listMemories(room,alice)).some(x=>x.id===m.id));
    await assert.rejects(memoryGraph(room,alice,m.id),/unavailable/);
  });
  await test('deleted evidence cascades records, jobs and edges',async()=>{
    const m=await approve(await fact('Disposable evidence.'));
    await db.query(`DELETE FROM session_messages WHERE id=$1`,[m.source_message_id]);
    assert.equal(await first(`SELECT id FROM memory_records WHERE id=$1`,[m.id]),undefined);
    assert.equal((await first(`SELECT count(*)::int n FROM memory_jobs WHERE memory_id=$1`,[m.id])).n,0);
  });
  await test('viewer writes, cross-room sources and cross-room edges are rejected',async()=>{
    const msg=await message('Other room evidence.',other);
    await assert.rejects(createMemory(room,bob,{kind:'fact',text:'Viewer write',sourceMessageId:msg}),/access/);
    await assert.rejects(createMemory(room,alice,{kind:'fact',text:'Scope jump',sourceMessageId:msg}),/unavailable/);
    const otherFact=await fact('Other room fact.',other);
    await assert.rejects(addMemoryEdge(room,alice,current.id,{relation:'supports',memoryId:otherFact.id}),/unavailable/);
    await assert.rejects(db.query(`INSERT INTO memory_edges(from_id,relation,to_memory_id) VALUES ($1,'supports',$2)`,[current.id,otherFact.id]),/mismatch/);
  });
  await test('code links use verified turn SHA and changed paths, and appear in retrieval',async()=>{
    await addMemoryEdge(room,alice,current.id,{relation:'implemented_by',turnId:gated.source_turn_id});
    await addMemoryEdge(room,alice,current.id,{relation:'mentions_file',turnId:gated.source_turn_id,path:'src/retry.ts'});
    await assert.rejects(addMemoryEdge(room,alice,current.id,{relation:'mentions_file',turnId:gated.source_turn_id,path:'invented.ts'}),/not part/);
    const hits=await recall('exponential backoff');
    assert.ok(hits.text.includes('b'.repeat(40)));assert.ok(hits.text.includes('src/retry.ts'));
  });
  await test('graph traversal terminates on cycles and enforces depth limits',async()=>{
    const a=await fact('Graph node a'),b=await fact('Graph node b');
    await addMemoryEdge(room,alice,a.id,{relation:'supports',memoryId:b.id});
    await addMemoryEdge(room,alice,b.id,{relation:'supports',memoryId:a.id});
    assert.equal((await memoryGraph(room,alice,a.id,4)).nodes.length,2);
    await assert.rejects(memoryGraph(room,alice,a.id,5),/depth/);
  });
  await test('retraction removes a memory even if sidecar still returns its old projection',async()=>{
    const m=await approve(await fact('Retractable setting quasar.'));
    await transitionMemory(room,alice,m.id,{status:'retracted',revision:m.revision});
    const hits=await recall('quasar',{},async()=>[{content:indexContent(m),score:1,importance:1,bank:'fake'}]);
    assert.ok(!hits.records.some(row=>row.id===m.id));
  });
  await test('retracting a source episode also excludes its already-approved derived claims',async()=>{
    const source=await exchange({prompt:'Confirm the orchard policy',reply:'The orchard policy is approved.'});
    const claim=await approve(await createMemory(room,alice,{kind:'fact',text:'The orchard policy is approved.',sourceMemoryId:source.id}));
    assert.ok((await recall('orchard')).records.some(m=>m.id===claim.id));
    await transitionMemory(room,alice,source.id,{status:'retracted',revision:source.revision});
    assert.ok(!(await recall('orchard',{},async()=>[{content:indexContent(claim),score:1,importance:1,bank:'fake'}])).records.some(m=>m.id===claim.id));
  });
  await test('knowledge entrypoint retrieves approved records across visible rooms with no sidecar',async()=>{
    const m=await approve(await fact('The team agreed heliotrope rollout in the other room.',other));
    const context=await buildKnowledgeContext({projectId:f.project,userId:alice,currentSessionId:room,prompt:'What did the team decide about heliotrope?'});
    assert.ok(context.memoryText.includes(m.id));assert.ok(context.memoryText.includes(m.source_message_id));
  });
  await test('configured extractor sends evidence as data and rejects malformed responses',async()=>{
    const originalFetch=globalThis.fetch;
    process.env.MEMORY_EXTRACTION_URL='https://extract.test/v1/chat/completions';process.env.MEMORY_EXTRACTION_MODEL='test';
    try {
      globalThis.fetch=async(_url,options)=>{
        const body=JSON.parse(options.body);assert.equal(JSON.parse(body.messages[1].content).exchange,episode.text);
        return Response.json({choices:[{message:{content:JSON.stringify({memories:[]})}}]});
      };
      assert.deepEqual(await extractClaims(episode),[]);
      globalThis.fetch=async()=>Response.json({choices:[{message:{content:'not json'}}]});
      await assert.rejects(extractClaims(episode));
    } finally {globalThis.fetch=originalFetch;delete process.env.MEMORY_EXTRACTION_URL;delete process.env.MEMORY_EXTRACTION_MODEL;}
  });
  await test('semantic transport requires a successful tool acknowledgement before deleting its job',async()=>{
    const m=await approve(await fact('Transport acknowledgement evidence.'));
    await hold();await ready(m.id);
    const originalFetch=globalThis.fetch;
    process.env.MNEMOSYNE_URL='https://memory.test/mcp';
    let fail=true;
    try {
      globalThis.fetch=async(_url,options)=>{
        const body=JSON.parse(options.body);
        if(body.method==='initialize') return Response.json({jsonrpc:'2.0',id:body.id,result:{}},{headers:{'mcp-session-id':'test-session'}});
        if(body.method==='notifications/initialized') return new Response(null,{status:202});
        assert.equal(body.params.name,'mnemosyne_remember');
        assert.equal(body.params.arguments.bank,`records-${room}`);
        assert.equal(body.params.arguments.content,indexContent(m));
        return Response.json({jsonrpc:'2.0',id:body.id,result:{isError:fail,structuredContent:{status:'stored'}}});
      };
      await processMemoryJob();
      assert.ok(await first(`SELECT last_error FROM memory_jobs WHERE memory_id=$1 AND operation='index'`,[m.id]));
      fail=false;await ready(m.id);await processMemoryJob();
      assert.equal(await first(`SELECT * FROM memory_jobs WHERE memory_id=$1 AND operation='index'`,[m.id]),undefined);
      assert.equal(await remember({bank:`records-${room}`,content:'',importance:0,channelId:room}),false);
    } finally {globalThis.fetch=originalFetch;delete process.env.MNEMOSYNE_URL;}
  });
} finally {await f.close();}

await test('migration recovers durable completions and preserves publication gates on legacy staging',async()=>{
  const legacy=await memoryFixture({deferMemoryMigration:true});
  try {
    const run=(await legacy.first(`INSERT INTO agent_runs(session_id,started_by,agent_id,base_sha,status)
      VALUES ($1,$2,'codex',$3,'completed') RETURNING id`,[legacy.room,legacy.alice,'a'.repeat(40)])).id;
    const plain=randomUUID(),code=randomUUID(),sha='d'.repeat(40);
    for(const [id,headSha] of [[plain,null],[code,sha]]) await legacy.db.query(`INSERT INTO agent_turns(id,run_id,driver_user_id,control_version,status,result,completion,ended_at)
      VALUES ($1,$2,$3,0,'completed',$4,$5,now())`,[id,run,legacy.alice,JSON.stringify({headSha,changes:[]}),JSON.stringify({userPrompt:'Historical question',output:'Historical response'})]);
    await legacy.db.query(`INSERT INTO staged_memory_exchanges(session_id,run_id,prompt,reply) VALUES ($1,$2,'Old proposal','Unpublished reply')`,[legacy.room,run]);
    await legacy.db.query(`DELETE FROM schema_migrations WHERE version='030_memory_records.sql'`);
    assert.deepEqual(await migrate(legacy.db),['030_memory_records.sql']);
    assert.deepEqual(await migrate(legacy.db),[]);
    const rows=(await legacy.db.query(`SELECT * FROM memory_records ORDER BY dedupe_key`)).rows;
    assert.equal(rows.length,3);
    const recovered=rows.find(m=>m.source_turn_id===plain),gated=rows.find(m=>m.source_turn_id===code),unknown=rows.find(m=>m.dedupe_key.startsWith('legacy:'));
    assert.equal(recovered.status,'approved');assert.equal(recovered.source_agent_message_id,null);
    assert.equal(gated.status,'proposed');assert.equal(gated.commit_sha,sha);
    assert.equal(unknown.publish_gated,true);
    for(const m of [gated,unknown]) await assert.rejects(transitionMemory(legacy.room,legacy.alice,m.id,{status:'approved',revision:1}),/Publish/);
    assert.equal((await legacy.first(`SELECT count(*)::int n FROM memory_jobs`)).n,4);
  } finally {await legacy.close();}
});
console.log(`${passed} memory lifecycle tests passed`);
