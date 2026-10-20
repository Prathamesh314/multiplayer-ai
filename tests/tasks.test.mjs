import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { createRun, getRun, listRunMessages } from "../app/lib/ai/runs.ts";
import { createTask, listTasks, taskMembers, updateTask } from "../app/lib/tasks/store.ts";
import { assignmentDraft } from "../app/lib/tasks/composer.ts";

const f = await memoryFixture();
let passed = 0;
async function test(name,work) { await work(); passed++; console.log(`  ok ${name}`); }
const rejects = (fn,status) => assert.rejects(fn,error => error.status === status);
try {
  await test("assignment text preserves repeated mentions and requires an exact selected handle",async () => {
    assert.deepEqual(assignmentDraft('@bob Ask @bob to review this.','bob'),{body:'Ask @bob to review this.'});
    assert.deepEqual(assignmentDraft('@BOB\nReview the changes.','bob'),{body:'Review the changes.'});
    assert.deepEqual(assignmentDraft('@bob ','bob'),{body:''});
    assert.equal(assignmentDraft('@bobby Review the changes.','bob'),null);
    assert.equal(assignmentDraft('@bob/chat-id is a chat reference.','bob'),null);
    assert.equal(assignmentDraft('Review the changes.','bob'),null);
    assert.deepEqual(assignmentDraft('#bob Review the changes.','bob'),{body:'Review the changes.'},'# tags a teammate');
    assert.deepEqual(assignmentDraft('Please #Bob check @app/lib/x.ts','bob'),{body:'Please check @app/lib/x.ts'},'files tagged with @ stay in the task');
    assert.equal(assignmentDraft('#bobby Review.','bob'),null);
  });
  const run = await createRun({sessionId:f.room,startedBy:f.alice,agentId:"codex",baseSha:"a".repeat(40),title:"Review retry logic"});
  const input = {id:randomUUID(),sessionId:f.room,runId:run.id,assigneeId:f.bob,body:"Please review the retry logic."};
  await test("optimized rosters match authoritative permissions through membership and visibility changes",async () => {
    const check=async room => {
      for(const actor of [f.alice,f.bob,f.outsider]) {
        const allowed=(await f.db.query('SELECT room_access_role($1,$2) AS role',[room,actor])).rows[0].role;
        const expected=allowed ? (await f.db.query('SELECT id FROM users WHERE id<>$2 AND room_access_role($1,id) IS NOT NULL',[room,actor])).rows.map(r=>r.id).sort() : [];
        assert.deepEqual((await taskMembers(room,actor)).map(m=>m.userId).sort(),expected);
      }
    };
    for(const change of [
      async()=>{},
      ()=>f.db.query("UPDATE org_members SET role='admin' WHERE user_id=$1",[f.outsider]),
      ()=>f.db.query("UPDATE org_members SET status='suspended' WHERE user_id=$1",[f.alice]),
      ()=>f.db.query("UPDATE project_members SET removed_at=now() WHERE user_id=$1",[f.alice]),
      ()=>f.db.query("UPDATE project_members SET role='viewer' WHERE user_id=$1",[f.alice]),
      ()=>f.db.query("UPDATE users SET deleted_at=now() WHERE id=$1",[f.bob]),
    ]) {
      await f.db.exec('BEGIN');
      try {await change();await check(f.room);await check(f.secret);} finally {await f.db.exec('ROLLBACK');}
    }
  });
  await test("assignments reach the assignee's inbox with source and authorship",async () => {
    await createTask(f.alice,input);
    const [task] = await listTasks(f.bob);
    assert.equal(task.id,input.id); assert.equal(task.sessionId,f.room); assert.equal(task.runId,run.id);
    assert.equal(task.creatorName,"Alice"); assert.equal(task.assigneeHandle,"bob"); assert.equal(task.status,"open");
    assert.equal((await listTasks(f.alice)).length,0);
  });
  await test("self-assignment is rejected for existing and new chats, including differently cased UUIDs",async () => {
    const before=(await f.db.query('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n;
    for (const assigneeId of [f.alice,f.alice.toUpperCase()]) {
      const id=randomUUID();
      await rejects(() => createTask(f.alice,{...input,id,assigneeId}),400);
      await rejects(() => createTask(f.alice,{id,sessionId:f.room,assigneeId,body:'Review my own work',newChat:{repoId:null,agentId:'codex'}}),400);
      assert.equal(await getRun(id),null);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM room_tasks WHERE id=$1',[id])).rows[0].n,0);
    }
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n,before);
    assert.equal((await getRun(run.id)).driverUserId,f.alice);
    assert(!(await taskMembers(f.room,f.alice)).some(member=>member.userId===f.alice));
  });
  await test("retrying or concurrently submitting one request creates exactly one task",async () => {
    await Promise.all([createTask(f.alice,input),createTask(f.alice,input)]);
    assert.equal((await listTasks(f.bob)).length,1);
    await rejects(() => createTask(f.alice,{...input,body:"Different request"}),409);
  });
  await test("inherited room members appear even without a room roster entry",async () => {
    assert.ok((await taskMembers(f.room,f.alice)).some(m => m.userId === f.bob));
    assert.ok(!(await taskMembers(f.room,f.alice)).some(m => m.userId === f.outsider));
  });
  await test("viewers can complete their own task, but cannot assign work",async () => {
    await updateTask(f.bob,input.id,"in_progress");
    await updateTask(f.bob,input.id,"done");
    assert.equal((await listTasks(f.bob))[0].status,"done");
    await rejects(() => createTask(f.bob,{...input,id:randomUUID(),assigneeId:f.alice}),403);
    await updateTask(f.alice,input.id,"open");
  });
  await test("unauthorised readers, assignees, and mismatched chat/room IDs are rejected",async () => {
    await rejects(() => createTask(f.outsider,{...input,id:randomUUID()}),403);
    await rejects(() => createTask(f.alice,{...input,id:randomUUID(),assigneeId:f.outsider}),403);
    await rejects(() => createTask(f.alice,{...input,id:randomUUID(),sessionId:f.other}),403);
    assert.deepEqual(await listTasks(f.outsider,{sessionId:f.room,runId:run.id}),[]);
    assert.deepEqual(await taskMembers(f.room,f.outsider),[]);
    await rejects(() => updateTask(f.outsider,input.id,"done"),403);
  });
  await test("editors assign from somebody else's chat without changing driver or AI transcript",async () => {
    await f.db.query(`INSERT INTO project_members(project_id,org_id,user_id,role) VALUES ($1,$2,$3,'editor')`,[f.project,f.org,f.outsider]);
    await createTask(f.outsider,{...input,id:randomUUID(),body:"Review this other person's chat."});
    assert.equal((await getRun(run.id)).driverUserId,f.alice);
    assert.equal((await listRunMessages(run.id)).length,0);
    await rejects(() => updateTask(f.outsider,input.id,"cancelled"),403);
  });
  await test("private room tasks never leak to project colleagues",async () => {
    const reviewer=(await f.db.query(`INSERT INTO users(handle,email,display_name,connect_code)
      VALUES ('reviewer','reviewer@tasks.test','Private reviewer','PK-AAAA-AAAD') RETURNING id`)).rows[0].id;
    await f.db.query("INSERT INTO org_members(org_id,user_id,role) VALUES ($1,$2,'member')",[f.org,reviewer]);
    await f.db.query("INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'viewer','owner')",[f.secret,reviewer]);
    const secretRun = await createRun({sessionId:f.secret,startedBy:f.outsider,agentId:"codex",baseSha:"b".repeat(40)});
    const secretTask = {...input,id:randomUUID(),sessionId:f.secret,runId:secretRun.id,assigneeId:reviewer};
    await createTask(f.outsider,secretTask);
    assert.deepEqual(await listTasks(f.alice,{sessionId:f.secret,runId:secretRun.id}),[]);
    assert.deepEqual(await taskMembers(f.secret,f.alice),[]);
    await rejects(() => createTask(f.alice,{...secretTask,id:randomUUID()}),403);
    await rejects(() => createTask(f.outsider,{...secretTask,id:randomUUID(),assigneeId:f.bob}),403);
  });
  await test("revoked membership immediately hides assignments and prevents updates",async () => {
    await f.db.query(`UPDATE project_members SET removed_at=now() WHERE project_id=$1 AND user_id=$2`,[f.project,f.bob]);
    assert.deepEqual(await listTasks(f.bob),[]);
    await rejects(() => updateTask(f.bob,input.id,"done"),403);
    await rejects(() => createTask(f.alice,{...input,id:randomUUID()}),403);
    await f.db.query(`UPDATE project_members SET removed_at=NULL WHERE project_id=$1 AND user_id=$2`,[f.project,f.bob]);
  });
  await test("invalid bodies, UUIDs and statuses return validation errors",async () => {
    for (const value of [null,[],{...input,id:"invalid"},{...input,body:" "},{...input,body:"x".repeat(4001)},{...input,assigneeId:3}]) {
      await rejects(() => createTask(f.alice,value),400);
    }
    await rejects(() => updateTask(f.bob,input.id,"invented"),400);
    await rejects(() => listTasks(f.bob,{sessionId:f.room,runId:"invalid"}),400);
  });
  await test("pagination includes completed tasks without silently losing older assignments",async () => {
    for (let n=0;n<52;n++) await createTask(f.alice,{...input,id:randomUUID(),body:`Task ${n}`});
    const first = await listTasks(f.bob), next = await listTasks(f.bob,undefined,50);
    assert.equal(first.length,51); assert.equal(next.length,4);
    assert.equal(new Set([...first.slice(0,50),...next].map(t => t.id)).size,54);
  });
  await test("a fresh composer creates one source chat and task atomically without an AI turn",async () => {
    const draft = {id:randomUUID(),sessionId:f.room,assigneeId:f.bob,body:"Review the new design",newChat:{repoId:null,agentId:"codex"}};
    const [first,retry] = await Promise.all([createTask(f.alice,draft),createTask(f.alice,draft)]);
    assert.deepEqual(first,{id:draft.id,runId:draft.id}); assert.deepEqual(retry,first);
    const chat = await getRun(first.runId);
    assert.equal(chat.driverUserId,f.alice); assert.equal(chat.status,"completed");
    assert.equal(chat.title,draft.body); assert.equal(chat.repoId,null);
    assert.equal((await listTasks(f.alice,{sessionId:f.room,runId:chat.id})).length,1);
    assert.equal((await listRunMessages(chat.id)).length,0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM agent_turns WHERE run_id=$1',[chat.id])).rows[0].n,0);
    await rejects(() => createTask(f.alice,{...draft,body:"Changed task"}),409);
    await rejects(() => createTask(f.alice,{...draft,newChat:{...draft.newChat,agentId:"claude"}}),409);
  });
  await test("fresh task chats preserve the selected repository and reject foreign or incomplete imports",async () => {
    for (const [id,scope,ready] of [["taskrepoaaaa",f.room,true],["taskrepobbbb",f.other,true],["taskrepocccc",f.room,false]]) {
      await f.db.query(`INSERT INTO room_repos(id,session_id,root_name,created_by,head_sha,seeded_at)
        VALUES ($1,$2,$1,$3,$4,$5)`,[id,scope,f.alice,ready ? "c".repeat(40) : null,ready ? new Date() : null]);
    }
    const draft = {id:randomUUID(),sessionId:f.room,assigneeId:f.bob,body:"Review this repository",newChat:{repoId:"taskrepoaaaa",agentId:"claude"}};
    const created = await createTask(f.alice,draft), chat = await getRun(created.runId);
    assert.equal(chat.repoId,"taskrepoaaaa"); assert.equal(chat.baseSha,"c".repeat(40));
    for (const repoId of ["taskrepobbbb","taskrepocccc","missingrepo"]) {
      const id=randomUUID();
      await rejects(() => createTask(f.alice,{...draft,id,newChat:{...draft.newChat,repoId}}),409);
      assert.equal(await getRun(id),null);
    }
  });
  await test("invalid fresh-chat assignments never leave an empty chat behind",async () => {
    const draft = {id:randomUUID(),sessionId:f.room,assigneeId:f.bob,body:"Review",newChat:{repoId:null,agentId:"codex"}};
    await rejects(() => createTask(f.bob,{...draft,assigneeId:f.alice}),403);
    assert.equal(await getRun(draft.id),null);
    await rejects(() => createTask(f.alice,{...draft,sessionId:f.secret}),403);
    await rejects(() => createTask(f.alice,{...draft,runId:run.id}),400);
    await rejects(() => createTask(f.alice,{...draft,newChat:{repoId:null,agentId:"unknown"}}),400);
    await rejects(() => createTask(f.alice,{...draft,newChat:null}),400);
    // Reusing an existing task ID must roll back the attempted new chat, too.
    await rejects(() => createTask(f.alice,{...draft,id:input.id}),409);
    assert.equal(await getRun(input.id),null);
  });
  await test("soft-deleted rooms disappear from the dashboard",async () => {
    await f.db.query(`UPDATE sessions SET deleted_at=now() WHERE id=$1`,[f.room]);
    assert.deepEqual(await listTasks(f.bob),[]);
    await rejects(() => updateTask(f.bob,input.id,"done"),403);
  });
  console.log(`${passed} task checks passed`);
} finally { await f.close(); }
