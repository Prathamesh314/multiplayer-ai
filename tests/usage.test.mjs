import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { memoryFixture } from './helpers/memory-fixture.mjs';
import { createRun } from '../app/lib/ai/runs.ts';
import { reserveTurn, failTurn } from '../app/lib/ai/turns.ts';
import { checkRunAllowed, orgUsage } from '../app/lib/ai/usage.ts';

const f = await memoryFixture();
try {
  const run = await createRun({sessionId:f.room, startedBy:f.alice, agentId:'codex', baseSha:'a'.repeat(40)});
  await f.db.query('UPDATE projects SET run_hourly_limit=1 WHERE id=$1', [f.project]);
  const first = randomUUID();
  await reserveTurn(run.id, f.alice, first, 0);
  await failTurn(first, 'Fixture completion');
  const gate = {orgId:f.org, projectId:f.project, sessionId:f.room, userId:f.alice, isNewRun:false};
  assert.equal((await checkRunAllowed(gate)).limit, 'project_hourly', 'continuations consume quota');
  await assert.rejects(reserveTurn(run.id, f.alice, randomUUID(), 0), error=>error.status===429 && /hourly/.test(error.message));
  await f.db.query("UPDATE agent_turns SET created_at=now()-interval '2 hours' WHERE id=$1", [first]);
  assert.equal((await checkRunAllowed(gate)).ok, true);
  await f.db.query('UPDATE projects SET run_hourly_limit=NULL WHERE id=$1', [f.project]);
  await f.db.query('UPDATE orgs SET run_monthly_quota=1 WHERE id=$1', [f.org]);
  // Put the first accepted turn in this month even when the test runs near midnight on the first.
  await f.db.query('UPDATE agent_turns SET created_at=now() WHERE id=$1', [first]);
  assert.equal((await checkRunAllowed(gate)).limit, 'org_monthly');
  await assert.rejects(reserveTurn(run.id, f.alice, randomUUID(), 0), error=>error.status===429 && /monthly/.test(error.message));
  assert.equal((await orgUsage(f.org)).monthly.used, 1);
  assert.equal((await f.first('SELECT count(*)::int AS n FROM agent_turns')).n, 1, 'denied attempts are not charged');
  await f.db.query("UPDATE agent_turns SET created_at=date_trunc('month', now())-interval '1 second' WHERE id=$1", [first]);
  assert.equal((await orgUsage(f.org)).monthly.used, 0);
  const second = randomUUID();
  await reserveTurn(run.id, f.alice, second, 0);
  await failTurn(second, 'Fixture completion');
  assert.equal((await orgUsage(f.org)).monthly.used, 1, 'new period admits another turn in the same conversation');
  console.log('Usage: continuations, hourly/monthly boundaries, atomic admission and UI totals passed.');
} finally { await f.close(); }
