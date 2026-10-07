import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { memoryFixture } from './helpers/memory-fixture.mjs';
import { createRun } from '../app/lib/ai/runs.ts';
import { reserveTurn } from '../app/lib/ai/turns.ts';
import { checkRunAllowed } from '../app/lib/ai/usage.ts';

// The preflight (checkRunAllowed) and the gate that actually admits work
// (reserveTurn) count the same rows. When they disagreed, a run whose executor
// died kept status='running' and the preflight ignored it while reserveTurn
// refused it: the UI showed free capacity and every submit returned 429, with
// no recovery except the worker's sweep — a separate process that may be down.
test('a run whose executor died stops holding admission slots', async (t) => {
  const f = await memoryFixture();
  const gate = { orgId: f.org, projectId: f.project, sessionId: f.room, userId: f.alice, isNewRun: true };
  const stale = async (runId) =>
    f.db.query(`UPDATE agent_runs SET started_at = now() - interval '20 minutes' WHERE id = $1`, [runId]);
  try {
    await t.test('a live run still blocks both gates', async () => {
      const run = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: 'codex', baseSha: 'a'.repeat(40) });
      await reserveTurn(run.id, f.alice, randomUUID(), 0);

      assert.equal((await checkRunAllowed(gate)).limit, 'room', 'preflight refuses a second concurrent run');
      const next = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: 'codex', baseSha: 'a'.repeat(40) });
      await assert.rejects(
        reserveTurn(next.id, f.alice, randomUUID(), 0),
        (error) => error.status === 429,
        'the gate refuses it too — the two agree while the run is live',
      );
    });

    await t.test('a stale run blocks neither gate', async () => {
      const [{ id: wedged }] = (await f.db.query(
        `SELECT id FROM agent_runs WHERE session_id = $1 AND status = 'running' ORDER BY started_at LIMIT 1`,
        [f.room],
      )).rows;
      await stale(wedged);

      assert.equal((await checkRunAllowed(gate)).ok, true, 'preflight ignores it past the window');
      const fresh = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: 'codex', baseSha: 'a'.repeat(40) });
      await reserveTurn(fresh.id, f.alice, randomUUID(), 0);
      assert.equal(
        (await f.first(`SELECT status FROM agent_turns WHERE run_id = $1`, [fresh.id])).status,
        'preparing',
        'the gate admits the turn instead of leaking the slot',
      );
    });

    await t.test('continuing the stale run itself reports the executor, not a phantom turn', async () => {
      const run = await createRun({ sessionId: f.other, startedBy: f.alice, agentId: 'codex', baseSha: 'a'.repeat(40) });
      await reserveTurn(run.id, f.alice, randomUUID(), 0);
      await stale(run.id);
      await f.db.query(`UPDATE agent_turns SET recovery_after = now() + interval '1 hour' WHERE run_id = $1`, [run.id]);

      await assert.rejects(
        reserveTurn(run.id, f.alice, randomUUID(), 0),
        (error) => /executor stopped responding/.test(error.message),
        'the message names the real problem',
      );
      // Still refused — one non-terminal turn per run — but the sweep can now
      // settle it instead of waiting out its backoff.
      const turn = await f.first(
        `SELECT recovery_after <= now() AS due FROM agent_turns WHERE run_id = $1 AND status = 'preparing'`,
        [run.id],
      );
      assert.equal(turn.due, true, 'the wedged turn is handed to recovery immediately');
    });

    console.log('Admission liveness: preflight and gate agree on live and stale executors.');
  } finally {
    await f.close();
  }
});
