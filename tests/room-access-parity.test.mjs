import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { memoryFixture } from './helpers/memory-fixture.mjs';

const f = await memoryFixture();
try {
  const original = (await readFile(new URL('../db/migrations/025_handoff_turns.sql', import.meta.url), 'utf8'))
    .split('\nALTER TABLE')[0].replace('FUNCTION room_access_role(', 'FUNCTION original_room_access_role(');
  await f.db.exec(original);
  // Keep another owner while exercising removal/suspension of the original owner.
  await f.db.query("UPDATE org_members SET role='owner' WHERE user_id=$1", [f.bob]);
  const personal = 'personaltest';
  await f.db.query("INSERT INTO sessions(id,owner_id,name,join_code,visibility) VALUES ($1,$2,'Personal','ABCD-EFGH','public')", [personal,f.alice]);
  const rooms = [f.room,f.secret,f.other,personal,'missingroomx'];
  const actors = [f.alice,f.bob,f.outsider,randomUUID(),null];
  async function compare(label) {
    const { rows } = await f.db.query(`SELECT room,actor,room_access_role(room,actor) AS actual,
      original_room_access_role(room,actor) AS expected
      FROM unnest($1::text[]) room CROSS JOIN unnest($2::uuid[]) actor`, [rooms,actors]);
    for (const row of rows) assert.equal(row.actual,row.expected,`${label}: ${row.room}/${row.actor}`);
  }
  let cases = 0;
  for (const deleted of [false,true]) for (const org of ['owner','admin','member','suspended','missing'])
    for (const project of ['manager','editor','viewer','removed','missing'])
      for (const member of ['owner','editor','viewer','removed','missing']) {
        await f.db.exec('BEGIN');
        try {
          await f.db.query('UPDATE users SET deleted_at=CASE WHEN $2 THEN now() END WHERE id=$1', [f.alice,deleted]);
          if (project === 'missing') await f.db.query('DELETE FROM project_members WHERE user_id=$1', [f.alice]);
          else await f.db.query("UPDATE project_members SET role=$2,removed_at=CASE WHEN $3 THEN now() END WHERE user_id=$1", [f.alice,project === 'removed' ? 'editor' : project,project === 'removed']);
          for (const room of [f.room,f.secret,personal]) {
            await f.db.query(`INSERT INTO session_members(session_id,user_id,role,added_via)
              VALUES ($1,$2,'owner','owner') ON CONFLICT DO NOTHING`, [room,f.alice]);
          }
          if (member === 'missing') await f.db.query('DELETE FROM session_members WHERE user_id=$1', [f.alice]);
          else await f.db.query('UPDATE session_members SET role=$2,removed_at=CASE WHEN $3 THEN now() END WHERE user_id=$1', [f.alice,member === 'removed' ? 'owner' : member,member === 'removed']);
          if (org === 'missing') await f.db.query('DELETE FROM org_members WHERE user_id=$1', [f.alice]);
          else await f.db.query('UPDATE org_members SET role=$2,status=$3 WHERE user_id=$1', [f.alice,org === 'suspended' ? 'member' : org,org === 'suspended' ? 'suspended' : 'active']);
          await compare([deleted,org,project,member].join('/')); cases++;
        } finally { await f.db.exec('ROLLBACK'); }
      }
  await f.db.query('UPDATE sessions SET deleted_at=now()');
  await compare('deleted rooms');
  console.log(`Room permissions match the original function across ${cases * rooms.length * actors.length + rooms.length * actors.length} checks.`);
} finally { await f.close(); }
