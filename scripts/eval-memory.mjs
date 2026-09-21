/** Retrieval bake-off on identical source records and permission/lifecycle
 * policy. No network by default. Optional adapter modules provide candidate
 * search; this harness ALWAYS hydrates through the production authority layer.
 * An adapter exports createAdapter({ records }) returning {name,search,
 * costUsd?,close?}. search accepts {bank,query,topK} and returns Memory[]. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { memoryFixture } from "../tests/helpers/memory-fixture.mjs";
import { createMemory, transitionMemory } from "../app/lib/knowledge/memory-records.ts";
import { recallMemories } from "../app/lib/knowledge/memory-retrieval.ts";
import { addMemoryEdge } from "../app/lib/knowledge/memory-edges.ts";
import { processMemoryJob } from "../app/lib/knowledge/memory-jobs.ts";

const fixture=await memoryFixture();
const adapters=[{name:'postgres-keyword',search:async()=>[],costUsd:()=>0}];
try {
  const make=async(text,room=fixture.room)=>{
    const m=await createMemory(room,fixture.alice,{kind:'fact',text,sourceMessageId:await fixture.message(text,room)});
    return transitionMemory(room,fixture.alice,m.id,{status:'approved',revision:m.revision});
  };
  const cross=await make('The approved authentication retry policy allows three attempts.',fixture.other);
  const old=await make('Zephyr caching policy uses Redis.');
  const next=await createMemory(fixture.room,fixture.alice,{kind:'fact',text:'Use Postgres for the current cache policy.',sourceMessageId:await fixture.message('Use Postgres for the current cache policy.')});
  const current=await transitionMemory(fixture.room,fixture.alice,next.id,{status:'approved',revision:1,supersedes:old.id});
  const proposal=await createMemory(fixture.room,fixture.alice,{kind:'fact',text:'Proposed authentication retry policy allows unlimited attempts.',sourceMessageId:await fixture.message('Proposed authentication retry policy allows unlimited attempts.')});
  const privateMessage=await fixture.message('Private authentication signing secret.',fixture.secret,fixture.outsider);
  const privateMemory=await createMemory(fixture.secret,fixture.outsider,{kind:'fact',text:'Private authentication signing secret.',sourceMessageId:privateMessage});
  await transitionMemory(fixture.secret,fixture.outsider,privateMemory.id,{status:'approved',revision:1});
  const turn=await fixture.exchange({sha:'c'.repeat(40),reply:'Implemented the current cache policy in src/retry.ts.'});
  // Test publication proof. Live Git ancestry is separately exercised by the
  // repository tests; this benchmark measures retrieval only.
  await processMemoryJob({published:async()=>true});
  await addMemoryEdge(fixture.room,fixture.alice,current.id,{relation:'implemented_by',turnId:turn.source_turn_id});
  const records=(await fixture.db.query(`SELECT * FROM memory_records`)).rows;
  if(process.env.MEMORY_EVAL_ADAPTER) {
    const adapterModule=await import(pathToFileURL(resolve(process.env.MEMORY_EVAL_ADAPTER)).href);
    adapters.push(await adapterModule.createAdapter({records}));
  }
  const cases=[
    {name:'decision-across-rooms',query:'authentication retry policy',expected:[cross.id]},
    {name:'superseded-decision',query:'Zephyr caching policy',expected:[current.id],forbidden:[old.id]},
    {name:'unapproved-proposal',query:'unlimited authentication attempts',expected:[],forbidden:[proposal.id]},
    {name:'private-room',query:'authentication signing secret',expected:[],forbidden:[privateMemory.id]},
    {name:'implementing-code',query:'current cache policy',expected:[current.id],commit:'c'.repeat(40)},
  ];
  const report=[];
  for(const adapter of adapters) {
    const timings=[],rows=[];
    for(const item of cases) {
      const start=performance.now();
      const result=await recallMemories({roomIds:[fixture.room,fixture.other,fixture.secret],userId:fixture.alice,prompt:item.query},adapter.search);
      const latencyMs=performance.now()-start;timings.push(latencyMs);
      const found=new Set(result.records.map(record=>record.id));
      const recall=item.expected.length ? item.expected.filter(id=>found.has(id)).length/item.expected.length : null;
      const leaks=(item.forbidden??[]).filter(id=>found.has(id)).length;
      const attributed=result.records.filter(record=>record.source_message_id||record.source_run_id||record.source_turn_id).length;
      const hasCode=!item.commit||result.text?.includes(item.commit);
      rows.push({name:item.name,recallAt8:recall,forbiddenHits:leaks,attributionRate:result.records.length?attributed/result.records.length:1,
        implementingCommitFound:!!hasCode,latencyMs:Number(latencyMs.toFixed(2))});
    }
    timings.sort((a,b)=>a-b);
    report.push({provider:adapter.name,cases:rows,p50LatencyMs:Number(timings[Math.floor(timings.length/2)].toFixed(2)),
      totalCostUsd:adapter.costUsd?await adapter.costUsd():null});
  }
  console.log(JSON.stringify({evaluation:'memory-retrieval-v1',note:'Retrieval and attribution checks; not an end-to-end answer-accuracy benchmark. Unknown provider costs remain null.',results:report},null,2));
  if(report.some(result=>result.cases.some(row=>row.forbiddenHits||row.attributionRate<1||!row.implementingCommitFound||row.recallAt8===0))) process.exitCode=1;
} finally {
  for(const adapter of adapters) await adapter.close?.();
  await fixture.close();
}
