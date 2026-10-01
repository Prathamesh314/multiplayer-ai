import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createRun } from "../app/lib/ai/runs.ts";
import { createRepo, finishSeed, writeSeedBatch } from "../app/lib/session/repo.ts";
import { attachRepo } from "../app/lib/session/store.ts";
import { RunnerGit } from "../runner/git.ts";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function eventually(task, label, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { if (await task()) return; } catch {}
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function browserChecks({ sql, directory, databaseUrl, redisUrl, alice, bob }) {
  const port = 3103;
  const chromePort = 9224;
  const server = `http://localhost:${port}`;
  const roomId = "browserrooms";
  await sql(`INSERT INTO sessions(id,name,join_code,owner_id) VALUES ($1,'Design workshop','ABCD-JKLM',$2)`, [roomId, alice]);
  await sql(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'owner','owner'),($1,$3,'editor','owner')`, [roomId, alice, bob]);
  await createRepo(roomId);
  await writeSeedBatch(roomId, [{ path: "welcome.txt", data: Buffer.from("Shared project\n").toString("base64") }]);
  const seed = await finishSeed(roomId, "Platform");
  await attachRepo(roomId, seed, null);
  const chat = await createRun({ sessionId: roomId, startedBy: alice, agentId: "codex", baseSha: seed.headSha, title: "Browser handoff" });
  const tokens = [];
  for (const userId of [alice, bob]) {
    const token = randomBytes(32).toString("base64url");
    await sql(`INSERT INTO auth_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')`, [userId, createHash("sha256").update(token).digest()]);
    tokens.push(token);
  }
  let output = "";
  const production = process.env.HANDOFF_TEST_PRODUCTION === "1";
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", ...(production ? ["start"] : ["dev", "--webpack"]), "--port", String(port)], {
    env: { ...process.env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl ?? "redis://localhost:6380",
      MULTIPLAYER_AI_DATA: directory, MNEMOSYNE_URL: "", LOCAL_RUNNERS: "1", AGENT_WORKER: "0",
      NODE_ENV: production ? "production" : "development", NEXT_TEST_DIST_DIR: production ? ".next" : ".next-handoff-test", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout.on("data", chunk => { output += chunk; });
  next.stderr.on("data", chunk => { output += chunk; });
  let chrome;
  let socket;
  const pending = new Map();
  let sequence = 0;
  const runtimeErrors = [];
  const networkRequests = [];
  let lastSessionId;
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 30_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const request = async (token, path, method = "GET", body) => fetch(`${server}${path}`, {
    method, headers: { cookie: `ma_auth=${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    await eventually(async () => (await fetch(`${server}/login`)).ok, "test server", 180);
    console.log("  ok actual Next.js API server started against isolated PostgreSQL schema");
    // Exercise authorization through real cookies/routes and an already-open
    // stream, not just a mocked guard or the database helper.
    const conversations=[];
    for (const input of [
      {kind:'channel',name:'Public review',visibility:'public'},
      {kind:'channel',name:'Private review',visibility:'private',memberIds:[bob]},
      {kind:'dm',userId:bob},
    ]) {
      const response=await request(tokens[0],'/api/chat/conversations','POST',{orgSlug:'handoff-org',...input});
      assert.equal(response.status,201);
      conversations.push((await response.json()).conversation.id);
    }
    const readers=[];
    try {
      for(const id of conversations) {
        assert.equal((await request(tokens[1],`/api/chat/conversations/${id}`)).status,200);
        const response=await request(tokens[1],`/api/chat/conversations/${id}/events`);
        assert.equal(response.status,200);
        const reader=response.body.getReader();readers.push(reader);
        assert.match(new TextDecoder().decode((await reader.read()).value),/event: ready/);
      }
      assert.equal((await request(tokens[0],`/api/orgs/handoff-org/members/${bob}`,'PATCH',{status:'suspended'})).status,200);
      for(const [index,id] of conversations.entries()) {
        for(const suffix of ['', '/messages', '/events']) assert.equal((await request(tokens[1],`/api/chat/conversations/${id}${suffix}`)).status,404);
        assert.equal((await request(tokens[1],`/api/chat/conversations/${id}/messages`,'POST',{body:'Forbidden'})).status,404);
        assert.equal((await request(tokens[0],`/api/chat/conversations/${id}/messages`,'POST',{body:'After suspension'})).status,201);
        const frame=await Promise.race([readers[index].read(),delay(5000).then(()=>{throw new Error('Revoked chat stream did not close');})]);
        assert.equal(frame.done,true,'revoked streams receive no message body');
      }
    } finally { await Promise.all(readers.map(reader=>reader.cancel().catch(()=>{}))); }
    assert.equal((await request(tokens[0],`/api/orgs/handoff-org/members/${bob}`,'PATCH',{status:'active'})).status,200);
    const probeToken=randomBytes(32).toString('base64url');
    const probeHash=createHash('sha256').update(probeToken).digest();
    await sql(`INSERT INTO auth_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')`,[bob,probeHash]);
    const tokenStream=await request(probeToken,`/api/chat/conversations/${conversations[0]}/events`);
    const tokenReader=tokenStream.body.getReader();await tokenReader.read();
    try {
      await sql('UPDATE auth_tokens SET revoked_at=now() WHERE token_hash=$1',[probeHash]);
      assert.equal((await request(tokens[0],`/api/chat/conversations/${conversations[0]}/messages`,'POST',{body:'After logout'})).status,201);
      const frame=await Promise.race([tokenReader.read(),delay(5000).then(()=>{throw new Error('Logged-out chat stream did not close');})]);
      assert.equal(frame.done,true);
    } finally { await tokenReader.cancel().catch(()=>{}); }
    assert.equal((await request(tokens[0],'/api/chat/conversations/invalid')).status,404);
    assert.equal((await request(tokens[0],`/api/chat/conversations/${conversations[0]}/messages?before=invalid`)).status,400);
    assert.equal((await request(tokens[0],`/api/chat/conversations/${conversations[0]}/messages`,'POST',null)).status,400);
    await sql("UPDATE sessions SET last_active_at=now()-interval '60 days',pinned=false WHERE id=$1",[roomId]);
    assert.equal((await request(tokens[0],'/api/sessions')).status,200);
    await delay(100);
    assert.equal((await sql('SELECT count(*)::int AS n FROM sessions WHERE id=$1',[roomId])).rows[0].n,1);
    console.log('  ok actual chat HTTP/SSE: public/private/DM suspension, token revocation, malformed input and non-destructive room listing');
    const endpoint = `/api/sessions/${roomId}/runs/${chat.id}/handoff`;
    assert.equal((await request(tokens[0], endpoint, "POST", { action: "wat", version: 0 })).status, 400);
    const created = await request(tokens[0], `/api/sessions/${roomId}/repos`, "POST", { name: "Imported storefront" });
    assert.equal(created.status, 200);
    const imported = (await created.json()).repo;
    const seedUrl = `/api/sessions/${roomId}/repos/${imported.id}/seed`;
    const seedBody = { files: [
      { path: "src/checkout.ts", data: Buffer.from("export const checkout = 'ready';\n").toString("base64") },
      { path: "src/components/Button.tsx", data: Buffer.from("export const Button = () => 'Continue';\n").toString("base64") },
      { path: ".env.example", data: Buffer.from("PUBLIC_NAME=Demo\n").toString("base64") },
    ], done: true };
    assert.equal((await request(tokens[0], seedUrl, "POST", seedBody)).status, 200);
    assert.equal((await request(tokens[0], seedUrl, "POST", seedBody)).status, 200);
    const importedFile = await request(tokens[1], `/api/sessions/${roomId}/file?repoId=${imported.id}&path=src/checkout.ts`);
    assert.match((await importedFile.json()).text, /ready/);
    console.log("  ok actual import API, finalization retry, and imported-file read");

    chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--remote-debugging-port=${chromePort}`, `--user-data-dir=${join(directory, "chrome")}`,
    ], { stdio: "ignore" });
    let version;
    await eventually(async () => { version = await fetch(`http://127.0.0.1:${chromePort}/json/version`).then(response => response.json()); return !!version.webSocketDebuggerUrl; }, "Chrome");
    socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const operation = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) operation?.reject(new Error(JSON.stringify(message.error)));
        else operation?.resolve(message.result);
      }
      if (message.method === "Network.requestWillBeSent") networkRequests.push({ sessionId: message.sessionId, url: message.params.request.url, method: message.params.request.method });
      if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
    async function tab(token, targetRoom = roomId, readySelector = 'select[aria-label="Active repository"]') {
      const { browserContextId } = await send("Target.createBrowserContext");
      const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const command = (method, params) => send(method, params, sessionId);
      await command("Page.enable"); await command("Runtime.enable"); await command("Network.enable");
      await command("Network.setCookie", { name: "ma_auth", value: token, url: server, httpOnly: true, sameSite: "Lax" });
      await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
      const evaluate = async expression => {
        lastSessionId = sessionId;
        const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      const click = text => eventually(() => evaluate(`(() => { const scope = document.querySelector('dialog[open]') ?? document; const button = Array.from(scope.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)} && button.checkVisibility() && !button.disabled); if (!button) return false; button.click(); return true; })()`), `click ${text}`);
      await command("Page.navigate", { url: `${server}/s/${targetRoom}` });
      try {
        await eventually(() => evaluate(`!!document.querySelector(${JSON.stringify(readySelector)})`), "room workspace");
      } catch (cause) {
        console.error(await evaluate("document.body.innerText.slice(0, 5000)"), runtimeErrors);
        throw cause;
      }
      return { command, evaluate, click, targetId, sessionId };
    }
    const sender = await tab(tokens[0]);
    const recipient = await tab(tokens[1]);
    await delay(2000);
    const baseline = networkRequests.length;
    await delay(16000);
    const idleReads = networkRequests.slice(baseline).filter(r => r.sessionId === sender.sessionId && r.method === "GET" && /\/api\/(tasks|ai\/agents|runner\/devices)|\/(members|handoffs|history)(?:\?|$)/.test(r.url));
    assert.deepEqual(idleReads, [], "Idle room does not poll tasks, providers, devices, members, handoffs or history");
    assert.equal(networkRequests.filter(r => r.sessionId === sender.sessionId && r.url === `${server}/api/sessions/${roomId}/events`).length, 1, "Room components share one SSE connection");
    console.log("  ok idle room: zero refresh GETs over 16 seconds; one shared room stream");
    // A human assignment from another person's chat must work independently
    // of AI provider availability and without transferring chat control.
    const assigner = await tab(tokens[1], `${roomId}?run=${chat.id}`);
    await assigner.click("@ Assign task");
    const aliceHandle = (await sql(`SELECT handle FROM users WHERE id=$1`,[alice])).rows[0].handle;
    const taskText = "Please review the changes in this shared chat.";
    await eventually(() => assigner.evaluate(`Array.from(document.querySelectorAll('datalist option')).some(o => o.value === ${JSON.stringify(`@${aliceHandle}`)})`), "room member picker");
    const assignerHandle=(await sql('SELECT handle FROM users WHERE id=$1',[bob])).rows[0].handle;
    assert.equal(await assigner.evaluate(`Array.from(document.querySelectorAll('datalist option')).some(o => o.value === ${JSON.stringify('@'+assignerHandle)})`),false);
    // Direct requests cannot bypass the picker, and rejected requests create
    // neither an assignment nor a fresh chat (including UUID casing changes).
    const chatsBeforeSelf=(await sql('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n;
    for(const assigneeId of [bob,bob.toUpperCase()]) {
      for(const source of [{runId:chat.id},{newChat:{repoId:imported.id,agentId:'codex'}}]) {
        const id=randomUUID();
        const response=await request(tokens[1],'/api/tasks','POST',{id,sessionId:roomId,assigneeId,body:'Forbidden self assignment',...source});
        assert.equal(response.status,400);assert.match((await response.json()).error,/yourself/);
        assert.equal((await sql('SELECT count(*)::int AS n FROM room_tasks WHERE id=$1',[id])).rows[0].n,0);
      }
    }
    assert.equal((await sql('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n,chatsBeforeSelf);
    await assigner.evaluate(`(() => {
      const form = document.querySelector('section[aria-label="Chat tasks"] form');
      const input = form.querySelector('input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(`@${aliceHandle}`)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
      const textarea = form.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,${JSON.stringify(taskText)});
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    // A failed delivery keeps the draft intact so the user can retry.
    await assigner.command("Network.enable",{});
    await assigner.command("Network.setBlockedURLs",{urls:["*/api/tasks"]});
    await assigner.click("Create task");
    await eventually(() => assigner.evaluate('!!document.querySelector(\'section[aria-label="Chat tasks"] [role="alert"]\')'), "task delivery failure");
    assert.equal(await assigner.evaluate('document.querySelector(\'section[aria-label="Chat tasks"] textarea\').value'),taskText);
    await assigner.command("Network.setBlockedURLs",{urls:[]});
    await assigner.click("Create task");
    await eventually(() => assigner.evaluate('document.querySelector(\'section[aria-label="Chat tasks"] [role="status"]\')?.textContent.includes("Task assigned")'), "task assignment confirmation");
    const stored = (await sql(`SELECT * FROM room_tasks WHERE run_id=$1`,[chat.id])).rows;
    assert.equal(stored.length,1);
    assert.equal(stored[0].assignee_id,alice);
    const withoutRoster=await (await request(tokens[1],`/api/tasks?sessionId=${roomId}&runId=${chat.id}&members=0`)).json();
    assert.equal(withoutRoster.tasks.length,1);
    assert.deepEqual(withoutRoster.members,[]);
    const rosterOnly=await (await request(tokens[1],`/api/tasks?sessionId=${roomId}`)).json();
    assert.equal(rosterOnly.tasks.length,0);
    assert.ok(rosterOnly.members.some(member=>member.userId===alice));
    assert.equal((await sql(`SELECT driver_user_id FROM agent_runs WHERE id=$1`,[chat.id])).rows[0].driver_user_id,alice);
    assert.equal((await fetch(`${server}/api/tasks`)).status,401);
    assert.equal((await request(tokens[1],"/api/tasks","POST",null)).status,400);
    assert.equal((await request(tokens[1],`/api/tasks/${stored[0].id}`,"PATCH",{status:"invalid"})).status,400);
    const inbox = await tab(tokens[0]);
    await inbox.command("Page.navigate",{url:`${server}/workspace`});
    await eventually(() => inbox.evaluate(`document.querySelector('section[aria-label="My tasks"]')?.textContent.includes(${JSON.stringify(taskText)})`), "assignee dashboard inbox");
    await inbox.evaluate(`(() => {const select=document.querySelector('section[aria-label="My tasks"] select');select.value='done';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await eventually(async () => (await sql(`SELECT status FROM room_tasks WHERE id=$1`,[stored[0].id])).rows[0].status === "done", "task completion saved");
    await inbox.evaluate('document.querySelector(\'section[aria-label="My tasks"] a\').click()');
    await eventually(() => inbox.evaluate(`location.search === ${JSON.stringify(`?run=${chat.id}`)} && document.querySelector('section[aria-label="Chat tasks"]')?.textContent.includes(${JSON.stringify(taskText)})`), "task source chat deep link");
    await assigner.evaluate('window.dispatchEvent(new Event("focus"))');
    await eventually(() => assigner.evaluate('document.querySelector(\'section[aria-label="Chat tasks"] select\')?.value === "done"'), "status refresh in source chat");
    // @people in the actual composer assigns a human task without running AI.
    const composerSelector = '.room-main textarea[placeholder="Type @ to assign a task to a teammate…"]';
    const setComposer = text => assigner.evaluate(`(() => {
      const textarea=document.querySelector(${JSON.stringify(composerSelector)});
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,${JSON.stringify(text)});
      textarea.setSelectionRange(textarea.value.length,textarea.value.length);
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await eventually(()=>assigner.evaluate(`!!document.querySelector(${JSON.stringify(composerSelector)})`),"task composer for non-driver");
    await setComposer('@');
    await eventually(()=>assigner.evaluate('document.body.textContent.includes("People & chat references")'),"people mention picker");
    assert.equal(await assigner.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes(${JSON.stringify('@'+assignerHandle+' ·')}) && button.textContent.includes('Assign task'))`),false);
    // An abandoned person selection must not attach itself to a later message.
    await assigner.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes(${JSON.stringify('@'+aliceHandle+' ·')}) && button.textContent.includes('Assign task')).click()`);
    await setComposer('A different message');
    await eventually(()=>assigner.evaluate('!document.querySelector(\'button[aria-label="Assign task"]\')'),"removed assignment target");
    await setComposer('@'+aliceHandle+' This was not selected as a task.');
    assert.equal(await assigner.evaluate('!!document.querySelector(\'button[aria-label="Assign task"]\')'),false);
    await setComposer('@');
    await eventually(()=>assigner.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes(${JSON.stringify('@'+aliceHandle+' ·')}) && button.textContent.includes('Assign task'))`),"picker after cancelled selection");
    await assigner.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes(${JSON.stringify('@'+aliceHandle+' ·')}) && button.textContent.includes('Assign task')).click()`);
    const taggedTask='Please verify the release checklist with @'+aliceHandle+'. Keep @'+aliceHandle+' informed.';
    await setComposer('@'+aliceHandle+' '+taggedTask);
    await assigner.command("Network.setBlockedURLs",{urls:["*/api/tasks"]});
    await assigner.evaluate(`document.querySelector('button[aria-label="Assign task"]').click()`);
    await eventually(()=>assigner.evaluate(`document.querySelector(${JSON.stringify(composerSelector)}).disabled === false && document.body.innerText.includes("Failed to fetch")`),"failed task keeps composer draft");
    assert.equal(await assigner.evaluate(`document.querySelector(${JSON.stringify(composerSelector)}).value`),'@'+aliceHandle+' '+taggedTask);
    await assigner.command("Network.setBlockedURLs",{urls:[]});
    const turnsBefore=(await sql('SELECT count(*)::int AS count FROM agent_turns')).rows[0].count;
    await assigner.evaluate(`document.querySelector('button[aria-label="Assign task"]').click()`);
    await eventually(async()=> (await sql('SELECT count(*)::int AS count FROM room_tasks WHERE run_id=$1',[chat.id])).rows[0].count===2,"composer task delivery");
    const tagged=(await sql('SELECT * FROM room_tasks WHERE run_id=$1 AND body=$2',[chat.id,taggedTask])).rows[0];
    assert.equal(tagged.assignee_id,alice);
    assert.equal((await sql('SELECT count(*)::int AS count FROM agent_turns')).rows[0].count,turnsBefore);
    await eventually(()=>assigner.evaluate(`document.querySelector(${JSON.stringify(composerSelector)}).value === ''`),"task composer clears after success");
    assert.equal((await sql('SELECT driver_user_id FROM agent_runs WHERE id=$1',[chat.id])).rows[0].driver_user_id,alice);
    console.log("  ok @person assignment from chat composer, failed-send recovery, and no AI turn or control transfer");
    // Regression: the screenshot reported by the user was the fresh composer,
    // before a run exists, with an imported repository selected.
    {
    const fresh = await tab(tokens[0]);
    await fresh.evaluate(`(() => {
      const select=document.querySelector('select[aria-label="Active repository"]');
      select.value=${JSON.stringify(imported.id)};select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    const freshSelector='.room-main textarea[placeholder="Type @ to assign a task, or connect an agent…"]';
    const writeFresh = text => fresh.evaluate(`(() => {
      const textarea=document.querySelector(${JSON.stringify(freshSelector)});
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,${JSON.stringify(text)});
      textarea.setSelectionRange(textarea.value.length,textarea.value.length);
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await eventually(()=>fresh.evaluate(`!!document.querySelector(${JSON.stringify(freshSelector)}) && !document.querySelector('section[aria-label="Chat tasks"]')`),"fresh chat task composer");
    const bobHandle=(await sql('SELECT handle FROM users WHERE id=$1',[bob])).rows[0].handle;
    await eventually(async()=>{
      await writeFresh('@');
      return fresh.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes(${JSON.stringify('@'+bobHandle+' ·')}) && button.textContent.includes('Assign task'))`);
    },"people in fresh composer mention picker");
    assert.ok(await fresh.evaluate('document.body.textContent.includes("People & chat references")'));
    assert.equal(await fresh.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes(${JSON.stringify('@'+aliceHandle+' ·')}) && button.textContent.includes('Assign task'))`),false);
    const preview=await fresh.command("Page.captureScreenshot",{format:"png"});
    await writeFile(join(tmpdir(), "new-chat-task-picker.png"),Buffer.from(preview.data,"base64"));
    await fresh.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes(${JSON.stringify('@'+bobHandle+' ·')}) && button.textContent.includes('Assign task')).click()`);
    const freshBody='Please review the imported storefront before we begin.';
    await writeFresh('@'+bobHandle+' '+freshBody);
    const chatCount=(await sql('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n;
    const turnCount=(await sql('SELECT count(*)::int AS n FROM agent_turns')).rows[0].n;
    await fresh.command("Network.enable",{});
    await fresh.command("Network.setBlockedURLs",{urls:["*/api/tasks"]});
    await fresh.evaluate(`document.querySelector('button[aria-label="Assign task"]').click()`);
    await eventually(()=>fresh.evaluate('document.body.textContent.includes("Failed to fetch")'),"fresh task send failure");
    assert.equal(await fresh.evaluate(`document.querySelector(${JSON.stringify(freshSelector)}).value`),'@'+bobHandle+' '+freshBody);
    assert.equal((await sql('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n,chatCount);
    await fresh.command("Network.setBlockedURLs",{urls:[]});
    await fresh.evaluate(`document.querySelector('button[aria-label="Assign task"]').click()`);
    await eventually(()=>fresh.evaluate(`document.querySelector('section[aria-label="Chat tasks"]')?.textContent.includes(${JSON.stringify(freshBody)})`),"new source chat opens with assigned task");
    const freshTask=(await sql('SELECT t.*,r.repo_id,r.driver_user_id FROM room_tasks t JOIN agent_runs r ON r.id=t.run_id WHERE t.body=$1',[freshBody])).rows;
    assert.equal(freshTask.length,1);assert.equal(freshTask[0].assignee_id,bob);
    assert.equal(freshTask[0].repo_id,imported.id);assert.equal(freshTask[0].driver_user_id,alice);
    assert.equal((await sql('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n,chatCount+1);
    assert.equal((await sql('SELECT count(*)::int AS n FROM agent_turns')).rows[0].n,turnCount);
    const taskInbox=await request(tokens[1],'/api/tasks');
    assert.ok((await taskInbox.json()).tasks.some(task=>task.id===freshTask[0].id));
    await send("Target.closeTarget",{targetId:fresh.targetId});
    console.log("  ok fresh-chat @people picker, failed-send draft recovery, selected repository, inbox delivery, and no AI execution");
    }
    for (const view of [assigner,inbox]) await send("Target.closeTarget",{targetId:view.targetId});
    console.log("  ok person tagging from another person's chat, failed-send draft recovery, dashboard assignment, completion, and source deep link");
    for (const view of [sender, recipient]) {
      await eventually(() => view.evaluate('document.querySelector(".room-sidebar")?.checkVisibility() && Array.from(document.querySelectorAll("button")).some(button => button.textContent === "Chats & team" && button.getAttribute("aria-expanded") === "true")'), "Chats & team open by default");
      await view.click("Chats & team");
      await eventually(() => view.evaluate('!document.querySelector(".room-sidebar")?.checkVisibility()'), "Chats & team can be hidden");
      await view.click("Chats & team");
      await eventually(() => view.evaluate('document.querySelector(".room-sidebar")?.checkVisibility()'), "Chats & team can be reopened");
    }
    await eventually(() => recipient.evaluate('document.querySelector(\'button[aria-label="File: welcome.txt"]\')?.checkVisibility()'), "files visible on initial room open");
    const catalogToken = randomBytes(32).toString("base64url");
    const catalogDevice = (await sql(`INSERT INTO runner_devices(user_id,name,token_hash,version,agent_ids) VALUES ($1,'Catalog fixture',$2,'2',ARRAY['codex','opencode']) RETURNING id`, [bob, createHash("sha256").update(catalogToken).digest()])).rows[0].id;
    const inventory = id => ({ choices: [{ id, label: id, efforts: [{ id: "high", label: "High" }] }], source: "Test provider", checkedAt: Date.now(), refreshedAt: Date.now(), stale: false });
    const advertise = async id => {
      const response = await fetch(`${server}/api/runner/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${catalogToken}`, "content-type": "application/json" },
        body: JSON.stringify({ version: "2", agentIds: ["codex", "opencode"], modelCatalog: { codex: inventory(""), opencode: inventory(id) } }) });
      assert.equal(response.status, 200);
    };
    await advertise("test-provider/release-one");
    await recipient.evaluate('window.dispatchEvent(new Event("focus"))');
    await eventually(() => recipient.evaluate('Array.from(document.querySelectorAll(\'select[aria-label="Provider"] option\')).some(option => option.value === "opencode")'), "discovered multi-provider execution option");
    await recipient.evaluate(`(() => { const select = document.querySelector('select[aria-label="Provider"]'); select.value = "opencode"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await recipient.evaluate('document.querySelector(\'button[aria-label="Choose model"]\').click()');
    await eventually(() => recipient.evaluate('document.querySelector("dialog")?.textContent.includes("test-provider/release-one")'), "runner model discovery in picker");
    await recipient.evaluate('Array.from(document.querySelectorAll("dialog button")).find(button => button.textContent.includes("test-provider/release-one")).click()');
    assert.equal(JSON.stringify(await (await request(tokens[0], "/api/ai/agents")).json()).includes("test-provider/release-one"), false, "Runner model catalogs are scoped to their owner");
    await advertise("test-provider/release-two");
    await recipient.evaluate('window.dispatchEvent(new Event("focus"))');
    await eventually(() => recipient.evaluate('document.querySelector(\'button[aria-label="Choose model"]\')?.textContent.includes("Unavailable: test-provider/release-one")'), "removed model stays pinned but is unavailable");
    const removed = await request(tokens[1], "/api/ai/run", "POST", { sessionId: roomId, agentId: "opencode", model: "test-provider/release-one", prompt: "Do not execute unavailable models" });
    assert.equal(removed.status, 409);
    await recipient.evaluate('document.querySelector(\'button[aria-label="Choose model"]\').click()');
    await eventually(() => recipient.evaluate('document.querySelector("dialog")?.textContent.includes("test-provider/release-two")'), "new release appears without a code update");
    await recipient.evaluate('Array.from(document.querySelectorAll("dialog button")).find(button => button.textContent.includes("test-provider/release-two")).click()');
    await recipient.evaluate(`(() => { const select = document.querySelector('select[aria-label="Provider"]'); select.value = "codex"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await sql(`UPDATE runner_devices SET revoked_at = now() WHERE id = $1`, [catalogDevice]);
    console.log("  ok live model-picker updates, new and retired models, per-user catalog isolation, and unavailable-model refusal");
    const beforeStarter = (await sql(`SELECT count(*)::int AS count FROM agent_turns`)).rows[0].count;
    await eventually(() => recipient.evaluate('Array.from(document.querySelectorAll("button")).some(button => button.textContent.trim() === "Understand this project")'), "starter prompts ready");
    await recipient.click("Understand this project");
    await eventually(() => recipient.evaluate('document.querySelector(".room-main textarea")?.value === "Explain what this project does"'), "starter fills composer without sending");
    assert.equal(await recipient.evaluate('document.activeElement === document.querySelector(".room-main textarea")'), true, "Starter focuses editable draft");
    await recipient.click("Review potential bugs");
    await eventually(() => recipient.evaluate('document.querySelector(".room-main textarea")?.value.includes("Explain what this project does\\n\\nReview this project")'), "starter preserves existing draft");
    assert.equal((await sql(`SELECT count(*)::int AS count FROM agent_turns`)).rows[0].count, beforeStarter, "Starter prompts never submit a model turn");
    const chatScreenshot = await recipient.command("Page.captureScreenshot", { format: "png" });
    await writeFile(join(tmpdir(), "ux-room-chat.png"), Buffer.from(chatScreenshot.data, "base64"));
    await recipient.click("Room guide");
    await eventually(() => recipient.evaluate('document.querySelector("dialog")?.textContent.includes("Review before sharing changes")'), "room guide explains workflow");
    await recipient.click("Open AI chat");
    await eventually(() => recipient.evaluate('!document.querySelector("dialog") && document.querySelector(".room-main textarea")?.value.includes("Explain what this project does")'), "guide navigation preserves chat draft");
    console.log("  ok guided navigation and editable, non-submitting starter prompts preserve drafts");
    for (const view of [sender]) {
      await eventually(() => view.evaluate("Array.from(document.querySelectorAll('button')).some(button => button.textContent.includes('Browser handoff'))"), "chat listing");
      await view.evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('Browser handoff')).click()");
      await eventually(() => view.evaluate("!!document.querySelector('section[aria-label=\"Chat control\"]')"), "handoff controls");
    }
    await sender.click("Hand off");
    await eventually(() => sender.evaluate("!!document.querySelector('dialog select')"), "handoff dialog");
    await sender.evaluate(`(() => { const select = document.querySelector('dialog select'); select.value = ${JSON.stringify(bob)}; select.dispatchEvent(new Event('change', { bubbles: true })); const note = document.querySelector('dialog textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(note, 'Continue the accessible checkout'); note.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sender.evaluate("document.querySelector('dialog form').requestSubmit()");
    await eventually(() => recipient.evaluate("document.body.textContent.includes('Open handoff')"), "recipient inbox");
    await recipient.click("Open handoff");
    await eventually(() => recipient.evaluate("document.body.textContent.includes('Accept control')"), "recipient offer via live API");
    await recipient.click("Accept control");
    await eventually(() => recipient.evaluate("document.body.textContent.includes('You are driving')"), "recipient owns chat");
    await eventually(() => sender.evaluate("document.body.textContent.includes('bob is driving')"), "sender control invalidation");
    console.log("  ok two independent browsers offer and accept a handoff using the real API and event bus");

    await recipient.evaluate(`(() => { const select = document.querySelector('select[aria-label="Active repository"]'); select.value = ${JSON.stringify(imported.id)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await eventually(() => recipient.evaluate("document.body.textContent.includes('checkout.ts')"), "imported file explorer");
    await eventually(() => recipient.evaluate('document.querySelector(\'button[aria-label="File: .env.example"]\')?.checkVisibility()'), "imported dotfiles visible");
    await recipient.evaluate('document.querySelector(\'button[aria-label="Folder: src/components"]\').click()');
    await eventually(() => recipient.evaluate('document.querySelector(\'button[aria-label="File: src/components/Button.tsx"]\')?.checkVisibility()'), "nested folder expansion");
    await recipient.evaluate(`(() => { const input = document.querySelector('.room-main textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Keep this draft while browsing files'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await recipient.evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('checkout.ts'))?.click()");
    await eventually(() => recipient.evaluate("document.body.textContent.includes('ready') || Array.from(document.querySelectorAll('textarea')).some(input => input.value.includes('ready'))"), "imported file editor");
    assert.equal(await recipient.evaluate('document.querySelector(\'button[aria-label="File: src/checkout.ts"]\')?.checkVisibility()'), true, "Explorer stays visible beside an opened file");
    assert.equal(await recipient.evaluate('document.querySelector(\'.room-main [role="tabpanel"]\').checkVisibility()'), false, "Chat is not displayed alongside file contents");
    assert.equal(await recipient.evaluate('document.querySelector(".room-file-document").checkVisibility()'), true, "File contents use the shared main panel");
    assert.equal(await recipient.evaluate('document.querySelector(".room-explorer-panel .room-file-document") === null'), true, "Right sidebar contains no second editor");
    await recipient.evaluate('document.querySelector(\'[role="tablist"] [role="tab"]\').click()');
    await eventually(() => recipient.evaluate('document.querySelector(\'.room-main [role="tabpanel"]\').checkVisibility() && !document.querySelector(".room-file-document").checkVisibility()'), "chat tab replaces file view");
    assert.equal(await recipient.evaluate('document.querySelector(".room-main textarea").value'), "Keep this draft while browsing files");
    await recipient.evaluate('document.querySelectorAll(\'[role="tablist"] [role="tab"]\')[1].click()');
    await recipient.evaluate('document.querySelectorAll(\'[role="tablist"] [role="tab"]\')[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }))');
    assert.equal(await recipient.evaluate('document.querySelector(\'[role="tablist"] [role="tab"]\').getAttribute("aria-selected")'), "true", "Keyboard navigation returns to chat");
    await recipient.evaluate('document.querySelectorAll(\'[role="tablist"] [role="tab"]\')[1].click()');
    console.log("  ok shared chat/file tabs show one panel at a time and preserve chat drafts");
    await recipient.evaluate(`(() => { const input = document.querySelector('input[aria-label="Filter files"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'src/'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await eventually(() => recipient.evaluate('document.querySelector(\'button[aria-label="File: src/checkout.ts"]\')?.checkVisibility()'), "path filter includes files within matching folder");
    await recipient.evaluate('document.querySelector(\'button[aria-label="Refresh files"]\').click()');
    await eventually(() => recipient.evaluate('document.querySelector(\'aside[aria-label="Repository explorer"]\').getAttribute("aria-busy") === "false"'), "explorer refresh");
    assert.equal(await recipient.evaluate('document.querySelector(\'input[aria-label="Filter files"]\').value'), "src/", "Refresh preserves filter");
    await recipient.evaluate('document.querySelector(\'button[aria-label="Clear file filter"]\').click()');
    for (const [width, height, name] of [[1440, 960, "desktop"], [1024, 768, "tablet"], [390, 844, "mobile"]]) {
      await recipient.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await delay(300);
      assert.equal(await recipient.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `No ${name} overflow`);
      await recipient.click("Room guide");
      await eventually(() => recipient.evaluate('document.querySelector("dialog")?.open'), `${name} guide opens`);
      assert.equal(await recipient.evaluate('document.querySelector("dialog").getBoundingClientRect().width <= innerWidth'), true, `${name} guide fits viewport`);
      if (name === "desktop") {
        const guideScreenshot = await recipient.command("Page.captureScreenshot", { format: "png" });
        await writeFile(join(tmpdir(), "ux-room-guide.png"), Buffer.from(guideScreenshot.data, "base64"));
      }
      await recipient.evaluate('document.querySelector(\'button[aria-label="Close Room guide"]\').click()');
      const screenshot = await recipient.command("Page.captureScreenshot", { format: "png" });
      await writeFile(join("/tmp", `handoff-room-${name}.png`), Buffer.from(screenshot.data, "base64"));
    }
    await recipient.click("Files & changes");
    await eventually(() => recipient.evaluate('document.querySelector(\'button[aria-label="File: src/checkout.ts"]\')?.checkVisibility()'), "mobile return to explorer");
    await recipient.evaluate('document.querySelector(\'button[aria-label="File: src/checkout.ts"]\').click()');
    await eventually(() => recipient.evaluate('document.querySelector(".room-file-document")?.checkVisibility()'), "mobile file editor");
    await recipient.command("Page.reload", {});
    await eventually(() => recipient.evaluate(`document.querySelector('select[aria-label="Active repository"]')?.value === ${JSON.stringify(imported.id)} && document.querySelector('button[aria-label="File: src/checkout.ts"]')?.checkVisibility()`), "reopened room restores imported repository and visible files");
    console.log("  ok persistent explorer, folder-path search, refresh, mobile navigation, and repository restoration");
    const uploadStarted = performance.now();
    await recipient.evaluate(`(() => {
      const input = document.querySelectorAll('input[type="file"]')[1];
      const file = new File(["export const uploaded = true;\\n"], "uploaded.ts", { type: "text/plain" });
      Object.defineProperty(file, 'webkitRelativePath', { value: 'Browser upload/uploaded.ts' });
      const transfer = new DataTransfer(); transfer.items.add(file);
      for (let i = 0; i < 1000; i++) {
        const item = new File(['contents ' + i], 'file' + i + '.txt', { type: 'text/plain' });
        Object.defineProperty(item, 'webkitRelativePath', { value: 'Browser upload/bulk/file' + i + '.txt' });
        transfer.items.add(item);
      }
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await eventually(() => recipient.evaluate("document.querySelector('select[aria-label=\"Active repository\"]').selectedOptions[0].textContent === 'Browser upload' && document.body.textContent.includes('uploaded.ts')"), "automatic file selection after folder upload");
    const uploadMs = Math.round(performance.now() - uploadStarted);
    const browserRepoId = await recipient.evaluate('document.querySelector(\'select[aria-label="Active repository"]\').value');
    const teammateFile = await request(tokens[0], `/api/sessions/${roomId}/file?repoId=${browserRepoId}&path=bulk/file999.txt`);
    assert.equal(teammateFile.status, 200);
    assert.equal((await teammateFile.json()).text, 'contents 999');
    console.log(`  ok browser uploads 1,001 files, selects the repository, and makes contents available to a teammate (${uploadMs} ms)`);

    const freshRoom = "freshbrowser";
    await sql(`INSERT INTO sessions(id,name,join_code,owner_id) VALUES ($1,'Fresh folder room','ABCD-RSTU',$2)`, [freshRoom, alice]);
    await sql(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'owner','owner')`, [freshRoom, alice]);
    await createRepo(freshRoom);
    const fresh = await tab(tokens[0], freshRoom, 'input[type="file"]');
    async function upload(view, inputIndex, root, path, contents) {
      await view.evaluate(`(() => {
        const input = document.querySelectorAll('input[type="file"]')[${inputIndex}];
        const file = new File([${JSON.stringify(contents)}], ${JSON.stringify(path.split("/").at(-1))}, { type: "text/plain" });
        Object.defineProperty(file, 'webkitRelativePath', { value: ${JSON.stringify(root + "/" + path)} });
        const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    }
    await upload(fresh, 0, "First project", "src/first.ts", "export const first = true;");
    await eventually(() => fresh.evaluate('document.querySelector(\'button[aria-label="File: src/first.ts"]\')?.checkVisibility()'), "initial project upload appears without reload");
    await upload(fresh, 1, "Second project", "lib/second.ts", "export const second = true;");
    await eventually(() => fresh.evaluate('document.querySelector(\'button[aria-label="File: lib/second.ts"]\')?.checkVisibility()'), "additional import in freshly seeded room");
    await fresh.evaluate(`(() => { const select = document.querySelector('select[aria-label="Active repository"]'); select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await eventually(() => fresh.evaluate('document.querySelector(\'button[aria-label="File: src/first.ts"]\')?.checkVisibility() && !document.querySelector(\'button[aria-label="File: lib/second.ts"]\')'), "switching back loads original repository");
    await fresh.command("Network.enable", {});
    await fresh.command("Network.setBlockedURLs", { urls: [`*/api/sessions/${freshRoom}/file?*`] });
    await fresh.evaluate('document.querySelector(\'button[aria-label="File: src/first.ts"]\').click()');
    await eventually(() => fresh.evaluate('document.body.textContent.includes("Retry file")'), "failed file read exits loading with retry");
    await fresh.command("Network.setBlockedURLs", { urls: [] });
    await fresh.click("Retry file");
    await eventually(() => fresh.evaluate('Array.from(document.querySelectorAll("textarea")).some(input => input.value.includes("export const first"))'), "retry opens file successfully");
    await fresh.command("Network.setBlockedURLs", { urls: [`*/api/sessions/${freshRoom}/tree?*`] });
    await fresh.evaluate('document.querySelector(\'button[aria-label="Refresh files"]\').click()');
    await eventually(() => fresh.evaluate('!!document.querySelector(\'aside[aria-label="Repository explorer"] [role="alert"]\')'), "tree refresh failure is visible rather than silently empty");
    await fresh.command("Network.setBlockedURLs", { urls: [] });
    await fresh.evaluate('document.querySelector(\'button[aria-label="Refresh files"]\').click()');
    await eventually(() => fresh.evaluate('!document.querySelector(\'aside[aria-label="Repository explorer"] [role="alert"]\') && document.querySelector(\'button[aria-label="File: src/first.ts"]\')?.checkVisibility()'), "tree retry preserves visible project files");
    console.log("  ok fresh-room uploads, second import, switching back, and recovery from real blocked file/tree requests");

    const deviceToken = randomBytes(32).toString("base64url");
    await sql(`INSERT INTO runner_devices(user_id,name,token_hash,version,agent_ids,last_seen_at,supports_inputs) VALUES ($1,'Simulated Bob runner',$2,'2',ARRAY['codex'],now(),true)`, [bob, createHash("sha256").update(deviceToken).digest()]);
    const runnerRequest = (path, body) => fetch(`${server}${path}`, { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const denied = await request(tokens[0], "/api/ai/run", "POST", { sessionId: roomId, agentId: "codex", runId: chat.id, controlVersion: 0, prompt: "Stale driver" });
    assert.equal(denied.status, 409);
    for (let index = 0; index < 2; index += 1) {
      const stream = await request(tokens[1], "/api/ai/run", "POST", { sessionId: roomId, agentId: "codex", runId: chat.id, controlVersion: 1, prompt: `Continue step ${index}`, turnId: randomUUID() });
      if (!stream.ok) throw new Error(`Run failed: ${stream.status} ${await stream.text()}`);
      const streamText = stream.text();
      const claim = await runnerRequest("/api/runner/claim", { version: "2", waitMs: 0 });
      const { job } = await claim.json();
      assert.ok(job);
      assert.equal(job.runId, chat.id);
      assert.match(job.agentPrompt, /Continue the accessible checkout/);
      if (index === 0) {
        await recipient.command("Page.navigate", {url:`${server}/s/${roomId}?run=${chat.id}`});
        await eventually(() => recipient.evaluate(`!!document.querySelector('textarea[aria-label="Message working agent"]')`), "working agent queue composer");
        const message = "Also verify keyboard navigation while working";
        await recipient.evaluate(`(() => { const input=document.querySelector('textarea[aria-label="Message working agent"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(message)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await recipient.click("Queue message");
        await eventually(() => recipient.evaluate(`document.querySelector('[aria-label="Chat message queue"]')?.textContent.includes(${JSON.stringify(message)})`), "queued instruction appears immediately");
        const inputEndpoint=`/api/sessions/${roomId}/runs/${chat.id}/inputs`;
        assert.equal((await request(tokens[0], inputEndpoint, "POST", {id:randomUUID(),body:"Unauthorized",controlVersion:1})).status,409);
        const claimed = await (await runnerRequest(`/api/runner/runs/${job.turnId}/inputs`,{kind:"claim",claimId:randomUUID()})).json();
        assert.equal(claimed.input.body,message);
        assert.equal((await runnerRequest(`/api/runner/runs/${job.turnId}/inputs`,{kind:"ack",id:claimed.input.id})).status,200);
        await eventually(() => recipient.evaluate(`document.querySelector('[aria-label="Chat message queue"]')?.textContent.includes("accepted by the agent")`), "provider acknowledgement arrives over live stream");
        assert.equal((await runnerRequest(`/api/runner/runs/${job.turnId}/inputs`,{kind:"claim",claimId:randomUUID(),closeIfEmpty:true})).status,200);
        console.log("  ok working-chat composer, durable queue, driver permissions and live acknowledgement through real APIs");
      }
      const runnerGit = new RunnerGit(server, deviceToken, join(directory, "simulated-runner"));
      const resultSha = await runnerGit.withWorkspace(job, async workspace => {
        await writeFile(join(workspace.path, `step-${index}.txt`), `Deterministic runner output ${index}\n`);
        return workspace.commitAndPush("Simulated turn", job.author);
      });
      const report = { code: 0, resultSha, output: `Finished step ${index}`, errOutput: "", ms: 5 };
      assert.equal((await runnerRequest(`/api/runner/runs/${job.turnId}/complete`, report)).status, 200);
      assert.equal((await runnerRequest(`/api/runner/runs/${job.turnId}/complete`, report)).status, 200);
      assert.match(await streamText, /"t":"exit"/);
    }
    const interrupted = await request(tokens[1], "/api/ai/run", "POST", { sessionId: roomId, agentId: "codex", runId: chat.id, controlVersion: 1, prompt: "Checkpoint unfinished work", turnId: randomUUID() });
    assert.equal(interrupted.status,200); const interruptedOutput=interrupted.text();
    const pendingJob=(await (await runnerRequest("/api/runner/claim",{version:"2",waitMs:0})).json()).job;
    const checkpointRunner=new RunnerGit(server,deviceToken,join(directory,"simulated-runner"));
    await checkpointRunner.withWorkspace(pendingJob,async workspace=>{
      await writeFile(join(workspace.path,"unfinished.txt"),"Available after laptop shutdown\n");
      await workspace.checkpoint();
    });
    await checkpointRunner.deliverCheckpoints({checkpoint:async snapshot=>{
      const reply=await runnerRequest(`/api/runner/runs/${pendingJob.turnId}/checkpoints`,snapshot);
      assert.equal(reply.status,200,await reply.text());
    }});
    const activityBody={sequence:1,events:[{t:"act",d:"Edited unfinished.txt"},{t:"out",d:"Saved before disconnect"}]};
    assert.equal((await runnerRequest(`/api/runner/runs/${pendingJob.turnId}/events`,activityBody)).status,200);
    assert.equal((await runnerRequest(`/api/runner/runs/${pendingJob.turnId}/events`,activityBody)).status,200);
    assert.equal((await runnerRequest(`/api/runner/runs/${pendingJob.turnId}/complete`,{code:1,resultSha:null,output:"Disconnected",errOutput:"Interrupted",ms:10})).status,200);
    await interruptedOutput;
    assert.equal((await runnerRequest(`/api/runner/runs/${pendingJob.turnId}/events`,{events:[]})).status,403,"An ended execution cannot renew its lease");
    const historyUrl=`/api/sessions/${roomId}/runs/${chat.id}/history`;
    const history=await (await request(tokens[0],historyUrl)).json(); assert.ok(history.snapshots.length);
    const checkpoint=history.snapshots[0];
    const replay=await (await request(tokens[0],historyUrl+`?turn=${pendingJob.turnId}`)).json();
    assert.equal(replay.batches.length,1); assert.equal(replay.batches[0].events[0].d,"Edited unfinished.txt");
    const changed=await (await request(tokens[0],historyUrl+`?snapshot=${checkpoint.id}&path=unfinished.txt`)).json();
    assert.match(changed.diff,/Available after laptop shutdown/);
    assert.equal((await request(tokens[0],historyUrl,"POST",{snapshotId:checkpoint.id,version:1})).status,409);
    assert.equal((await request(tokens[1],historyUrl,"POST",{snapshotId:checkpoint.id,version:1})).status,200);
    await recipient.command("Page.navigate",{url:`${server}/s/${roomId}?run=${chat.id}`});
    await eventually(()=>recipient.evaluate('document.body.textContent.includes("Activity & checkpoints")'),"workspace history controls");
    await recipient.click("Activity & checkpoints");
    await eventually(()=>recipient.evaluate(`document.querySelector('select[aria-label="Code checkpoint"]')?.options.length > 1`),"uploaded checkpoint visible");
    await recipient.evaluate(`(()=>{const select=document.querySelector('select[aria-label="Code checkpoint"]');select.value=${JSON.stringify(checkpoint.id)};select.dispatchEvent(new Event("change",{bubbles:true}));})()`);
    await eventually(()=>recipient.evaluate('document.querySelector("dialog")?.textContent.includes("unfinished.txt")'),"offline checkpoint files");
    await recipient.click("A unfinished.txt");
    await eventually(()=>recipient.evaluate('document.querySelector("dialog pre")?.textContent.includes("Available after laptop shutdown")'),"checkpoint diff displayed");
    const historyScreenshot=await recipient.command("Page.captureScreenshot",{format:"png"});
    await writeFile(join(tmpdir(), "workspace-history.png"),Buffer.from(historyScreenshot.data,"base64"));
    await recipient.evaluate(`document.querySelector('button[aria-label="Close Synchronized workspace history"]').click()`);
    console.log("  ok real checkpoint push/report, durable activity retry/replay, offline diff browsing, driver-only restore selection, and history UI");
    assert.deepEqual(runtimeErrors, []);
    console.log("  ok real run/claim/smart-HTTP/completion APIs: two successive turns on recipient device, duplicate completion, old-driver refusal");
    assert.equal((await request(tokens[0], "/api/orgs", "POST", { name: "UX workshop", slug: "ux-workshop" })).status, 201);
    await Promise.all([
      fetch(server),
      ...["/api/orgs/ux-workshop/projects", "/api/orgs/ux-workshop/usage", "/api/chat/conversations?org=ux-workshop", "/api/invitations", "/api/runner/devices"].map(path => request(tokens[0], path)),
    ]);
    await sender.command("Page.navigate", { url: `${server}/workspace` });
    await eventually(() => sender.evaluate('!!document.querySelector(\'button[title="UX workshop"]\')'), "organization navigation");
    await sender.evaluate('document.querySelector(\'button[title="UX workshop"]\').click()');
    await eventually(() => sender.evaluate('document.querySelector("main h1")?.textContent === "UX workshop"'), "guided project overview");
    assert.equal(await sender.evaluate('document.querySelector("dialog") === null'), true, "First visit does not interrupt onboarding with provider setup");
    await sender.click("New project");
    await eventually(() => sender.evaluate('document.querySelector("dialog")?.textContent.includes("add as many repositories as your work needs")'), "project setup");
    assert.equal(await sender.evaluate(`document.querySelector('dialog input[type="url"]') === null`), true, "A project does not bind a single repository");
    await sender.click("Cancel");
    await sender.command("Network.enable", {});
    await sender.command("Network.setBlockedURLs", { urls: ["*/api/ai/agents*"] });
    await sender.click("Set up AI");
    await eventually(() => sender.evaluate('document.querySelector("dialog")?.textContent.includes("Connect a computer.")'), "AI setup provides next steps");
    await eventually(() => sender.evaluate('!!document.querySelector("dialog [role=alert]")'), "AI setup failures surface with a retry");
    await sender.command("Network.setBlockedURLs", { urls: [] });
    await sender.click("Check connections");
    await eventually(() => sender.evaluate('!document.querySelector("dialog [role=alert]") && document.querySelectorAll("dialog li").length > 0'), "AI setup refresh recovers");
    await sender.command("Network.setBlockedURLs", { urls: ["*/api/runner/devices*"] });
    await sender.click("Connect your computer");
    await eventually(() => sender.evaluate('document.querySelector("dialog")?.textContent.includes("The desktop app connects this computer automatically after sign-in")'), "AI setup links to device pairing");
    await eventually(() => sender.evaluate('!!document.querySelector("dialog [role=alert]")'), "device loading failures are visible");
    await sender.command("Network.setBlockedURLs", { urls: [] });
    await sender.click("Try again");
    await eventually(() => sender.evaluate('!document.querySelector("dialog [role=alert]") && Array.from(document.querySelectorAll("dialog button")).some(button => button.textContent.trim() === "Connect a computer" && !button.disabled)'), "device loading retry recovers");
    await sender.click("Connect a computer");
    await eventually(() => sender.evaluate('document.querySelector("dialog")?.textContent.includes("multiplayer-ai-runner pair")'), "standalone runner pairing instructions");
    const instructions = await sender.evaluate('document.querySelector("dialog").textContent');
    assert.ok(instructions.includes(`${server}/downloads/multiplayer-ai-runner.tgz`));
    assert.ok(instructions.includes('multiplayer-ai-runner start'));
    assert.ok(!instructions.includes('npm run runner'));
    const download = await fetch(`${server}/downloads/multiplayer-ai-runner.tgz`);
    assert.equal(download.status, 200);
    const artifact = new Uint8Array(await download.arrayBuffer());
    assert.deepEqual([...artifact.slice(0, 2)], [0x1f, 0x8b], 'download is the actual gzip package');
    await sender.click("Done");
    await eventually(() => sender.evaluate('!document.querySelector("dialog") && document.querySelector("main h1")?.textContent === "UX workshop"'), "return to project overview");
    for (const [width, height, name] of [[1440, 960, "desktop"], [390, 844, "mobile"]]) {
      await sender.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await delay(300);
      assert.equal(await sender.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `${name} onboarding has no horizontal overflow`);
      const screenshot = await sender.command("Page.captureScreenshot", { format: "png" });
      await writeFile(join(tmpdir(), `ux-projects-${name}.png`), Buffer.from(screenshot.data, "base64"));
    }
    assert.deepEqual(runtimeErrors, []);
    console.log("  ok non-interrupting onboarding, honest GitHub setup, AI-to-device setup, and responsive project overview");
  } catch (cause) {
    if (lastSessionId) {
      const diagnostic = await send("Runtime.evaluate", { expression: "document.body?.innerText.slice(0, 5000)", returnByValue: true }, lastSessionId).catch(() => null);
      console.error("Last browser state:", diagnostic?.result?.value);
    }
    throw cause;
  } finally {
    await writeFile(join(tmpdir(), "handoff-browser-server.log"), output);
    socket?.close();
    for (const child of [chrome, next]) {
      if (!child || child.exitCode !== null) continue;
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([stopped, delay(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}
