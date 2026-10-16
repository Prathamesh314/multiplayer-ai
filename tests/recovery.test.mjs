import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import nextEnv from '@next/env';
import {memoryFixture} from './helpers/memory-fixture.mjs';
import {recoverAgentTurns} from '../app/lib/ai/recovery.ts';
import {prepareTurn} from '../app/lib/ai/turns.ts';
import {finalizeAgentRun} from '../app/lib/ai/finalize.ts';

if(process.env.RECOVERY_TEST_POSTGRES==='1')nextEnv.loadEnvConfig(process.cwd());
delete process.env.REDIS_URL;delete process.env.MNEMOSYNE_URL;

test('durable recovery: crashes, fresh leases, saved completions, late writers and concurrent workers',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mp-recovery-'));
  process.env.MULTIPLAYER_AI_DATA=directory;
  const f=await memoryFixture({postgres:process.env.RECOVERY_TEST_POSTGRES==='1'});
  async function make(status='preparing',target='server') {
    const run=(await f.first(`INSERT INTO agent_runs(session_id,started_by,agent_id,base_sha,status)
      VALUES ($1,$2,'codex',$3,'running') RETURNING id`,[f.room,f.alice,'a'.repeat(40)])).id;
    const id=randomUUID();
    await f.db.query(`INSERT INTO agent_turns(id,run_id,driver_user_id,control_version,status,execution_target) VALUES ($1,$2,$3,0,$4,$5)`,[id,run,f.alice,status,target]);
    const job={turnId:id,runId:run,userId:f.alice,controlVersion:0,sessionId:f.room,repoId:null,baseSha:'a'.repeat(40),agentId:'codex',agentPrompt:'Explain retries',userPrompt:'Explain retries',author:{name:'Alice',email:'alice@memory.test'}};
    const completion={...job,binName:'codex',sha:null,code:0,output:'Three retries.',errOutput:''};
    return {id,run,job,completion};
  }
  async function state(id) {return f.first('SELECT * FROM agent_turns WHERE id=$1',[id]);}
  try {
    await t.test('interrupted preparation frees the slot, records uncertainty and rejects late preparation',async()=>{
      const x=await make();
      await f.db.query(`UPDATE agent_turns SET created_at=now()-interval '6 minutes' WHERE id=$1`,[x.id]);
      assert.equal(await recoverAgentTurns(),1);
      assert.equal((await state(x.id)).status,'failed');
      assert.equal((await f.first('SELECT control_version FROM agent_runs WHERE id=$1',[x.run])).control_version,1);
      await assert.rejects(prepareTurn(x.job),/no longer waiting/);
    });
    await t.test('local preparation and dispatch are atomic; idle queued work expires without execution',async()=>{
      const x=await make();await prepareTurn(x.job);
      assert.equal((await f.first('SELECT status FROM runner_jobs WHERE turn_id=$1',[x.id])).status,'queued');
      assert.equal(await recoverAgentTurns(),0);
      await f.db.query(`UPDATE agent_turns SET prepared_at=now()-interval '16 minutes' WHERE id=$1`,[x.id]);
      await recoverAgentTurns();assert.equal((await state(x.id)).status,'failed');
      assert.equal((await f.first('SELECT status FROM runner_jobs WHERE turn_id=$1',[x.id])).status,'failed');
    });
    await t.test('a turn recorded as server-executed before that was removed is recovered, and its late completion refused',async()=>{
      // New turns always run on members' computers; this is data from before.
      const x=await make('running','server');
      await f.db.query(`UPDATE agent_turns SET execution_token=$2,execution_lease_until=now()+interval '1 minute' WHERE id=$1`,[x.id,randomUUID()]);
      assert.equal(await recoverAgentTurns(),0,'a live legacy lease is left alone');
      await f.db.query(`UPDATE agent_turns SET execution_lease_until=now()-interval '1 second' WHERE id=$1`,[x.id]);
      await assert.rejects(finalizeAgentRun(x.completion),/lease expired/);
      await recoverAgentTurns();assert.equal((await state(x.id)).status,'failed');
    });
    await t.test('preparing a turn always hands it to the member\'s computer',async()=>{
      const x=await make();await prepareTurn(x.job);
      assert.equal((await state(x.id)).execution_target,'local');
      assert.equal((await f.first('SELECT status FROM runner_jobs WHERE turn_id=$1',[x.id])).status,'queued');
    });
    await t.test('expired desktop lease closes queued inputs and preserves uncertain delivery',async()=>{
      const x=await make('running','local');
      await f.db.query(`INSERT INTO runner_jobs(run_id,turn_id,user_id,payload,status,lease_expires_at)
        VALUES ($1,$2,$3,$4,'claimed',now()-interval '1 second')`,[x.run,x.id,f.alice,JSON.stringify(x.job)]);
      for(const status of ['queued','delivering'])await f.db.query(`INSERT INTO agent_run_inputs(id,run_id,turn_id,user_id,control_version,body,status)
        VALUES ($1,$2,$3,$4,0,'Follow-up instruction',$5)`,[randomUUID(),x.run,x.id,f.alice,status]);
      await recoverAgentTurns();
      assert.ok((await state(x.id)).input_closed_at);
      assert.equal((await state(x.id)).result.uncertain,true);
      const late=await finalizeAgentRun(x.completion);
      assert.equal(late.status,'failed');assert.equal(late.headSha,null);
      const inputs=(await f.db.query('SELECT status FROM agent_run_inputs WHERE turn_id=$1 ORDER BY position',[x.id])).rows;
      assert.deepEqual(inputs.map(x=>x.status),['failed','unconfirmed']);
    });
    await t.test('persisted completion finalizes once even when recovery workers race',async()=>{
      const x=await make('running');
      await f.db.query(`UPDATE agent_turns SET completion=$2,execution_lease_until=now()-interval '1 second' WHERE id=$1`,[x.id,JSON.stringify(x.completion)]);
      await Promise.all([recoverAgentTurns(),recoverAgentTurns()]);
      assert.equal((await state(x.id)).status,'completed');
      const count=await f.first(`SELECT count(*)::int AS n FROM agent_run_messages WHERE run_id=$1 AND role='agent'`,[x.run]);
      assert.equal(count.n,1);
      assert.equal(await recoverAgentTurns(),0);
    });
    await t.test('revoked access cancels even a saved completion and retains the payload for review',async()=>{
      const x=await make('running');
      await f.db.query(`UPDATE agent_turns SET completion=$2 WHERE id=$1`,[x.id,JSON.stringify(x.completion)]);
      await f.db.query(`UPDATE project_members SET role='viewer' WHERE project_id=$1 AND user_id=$2`,[f.project,f.alice]);
      await recoverAgentTurns();
      assert.equal((await state(x.id)).status,'failed');
      assert.equal((await state(x.id)).completion.output,'Three retries.');
      await f.db.query(`UPDATE project_members SET role='editor' WHERE project_id=$1 AND user_id=$2`,[f.project,f.alice]);
    });
    await t.test('an expired worker claim is recoverable; fresh claims are not stolen',async()=>{
      const x=await make();
      await f.db.query(`UPDATE agent_turns SET created_at=now()-interval '6 minutes',recovery_token=$2,recovery_after=now()+interval '1 minute' WHERE id=$1`,[x.id,randomUUID()]);
      assert.equal(await recoverAgentTurns(),0);
      await f.db.query(`UPDATE agent_turns SET recovery_after=now()-interval '1 second' WHERE id=$1`,[x.id]);
      assert.equal(await recoverAgentTurns(),1);assert.equal((await state(x.id)).status,'failed');
    });
  } finally {await f.close();await rm(directory,{recursive:true,force:true});}
});
