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
  assert.equal((await orgUsage(f.org)).monthly.used, 1, 'new period admits another turn in the same conversation');
  await failTurn(second, 'Fixture completion');

  // Concurrency: every turn runs on a member's own computer, so nothing caps
  // how many run at once, even where an old deployment left a cap configured.
  assert.deepEqual(await f.first('SELECT run_concurrency_limit, parallel_chats_per_user FROM orgs WHERE id=$1', [f.org]),
    { run_concurrency_limit: null, parallel_chats_per_user: null }, 'new orgs start uncapped');
  await f.db.query('UPDATE orgs SET run_monthly_quota=NULL, run_concurrency_limit=2, parallel_chats_per_user=1 WHERE id=$1', [f.org]);
  const rooms = Array.from({ length: 8 }, (_, index) => `capsroom${'abcdefgh'[index]}xyz`);
  const runs = [], projects = [];
  for (const id of rooms) {
    // One member room per project, so each room gets a project of its own in the org.
    const project = (await f.first(`INSERT INTO projects(org_id,slug,name,created_by,run_concurrency_limit) VALUES ($1,$2,$3,$4,1) RETURNING id`, [f.org, id, id, f.alice])).id;
    projects.push(project);
    await f.db.query(`INSERT INTO sessions(id,owner_id,org_id,project_id,name,join_code,visibility) VALUES ($1,$2,$3,$4,$1,'ABCD-EFGH','public')`, [id, f.alice, f.org, project]);
    await f.db.query(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'owner','owner')`, [id, f.alice]);
    runs.push(await createRun({ sessionId: id, startedBy: f.alice, agentId: 'codex', baseSha: 'a'.repeat(40) }));
  }
  for (const [index, run] of runs.entries()) {
    const gate = { orgId: f.org, projectId: projects[index], sessionId: rooms[index], userId: f.alice, isNewRun: true };
    assert.equal((await checkRunAllowed(gate)).ok, true, `turn ${index + 1} is admitted`);
    await reserveTurn(run.id, f.alice, randomUUID(), 0);
  }
  assert.equal((await f.first(`SELECT count(*)::int AS n FROM agent_turns WHERE run_id = ANY($1) AND execution_target = 'local'`, [runs.map(run => run.id)])).n, 8, 'every turn is recorded for a member\'s computer');
  assert.deepEqual((await orgUsage(f.org)).concurrency, { used: 8 }, 'the display counts every running turn');
  console.log('Usage: continuations, hourly/monthly boundaries, atomic admission, uncapped concurrency and UI totals passed.');
} finally { await f.close(); }
