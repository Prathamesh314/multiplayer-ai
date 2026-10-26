import {clerkFixture,clerkCookie} from "./helpers/clerk-fixture.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createRun } from "../app/lib/ai/runs.ts";
import { createRepo, finishSeed, writeSeedBatch } from "../app/lib/session/repo.ts";
import { attachRepo } from "../app/lib/session/store.ts";
import { RunnerGit } from "../runner/git.ts";
import { RunnerApi } from "../runner/api.ts";
import { TerminalHost } from "../runner/terminal.ts";

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function readRunStream(response) {
  const output = response.text();
  // Observe failures immediately, while runner/browser assertions are in flight.
  // Awaiting output still rejects normally; teardown must not mask the assertion
  // that caused the server to close an unfinished stream.
  void output.catch(() => {});
  return output;
}
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
  const clerk=await clerkFixture();
  const tokens = [];
  for (const userId of [alice, bob]) {
    tokens.push(await clerk.link({query:sql},userId));
  }
  let output = "";
  const production = process.env.HANDOFF_TEST_PRODUCTION === "1";
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", ...(production ? ["start"] : ["dev", "--webpack"]), "--port", String(port)], {
    env: { ...process.env, ...clerk.env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl ?? "redis://localhost:6380",
      MULTIPLAYER_AI_DATA: directory, MNEMOSYNE_URL: "", LOCAL_RUNNERS: "1", AGENT_WORKER: "0",
      NODE_ENV: production ? "production" : "development", NEXT_TEST_DIST_DIR: production ? (process.env.NEXT_TEST_DIST_DIR || ".next") : ".next-handoff-test", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout.on("data", chunk => { output += chunk; });
  next.stderr.on("data", chunk => { output += chunk; });
  let chrome;
  let socket;
  const pending = new Map();
  let sequence = 0;
  /** Clerk's frontend API, script CDN and telemetry: never contacted by these tests. */
  const CLERK_FRONTEND = ["*clerk.accounts.dev*", "*clerk-telemetry.com*"];
  const runtimeErrors = [];
  const consoleErrors = [];
  const networkRequests = [];
  let lastSessionId;
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 30_000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const request = async (token, path, method = "GET", body) => fetch(`${server}${path}`, {
    method, headers: { cookie: clerkCookie(token), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    await eventually(async () => (await fetch(`${server}/health/ready`)).ok, "test server dependencies", 180);
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
    const probeToken=await clerk.link({query:sql},bob,{sessionId:'session_probe'});
    const tokenStream=await request(probeToken,`/api/chat/conversations/${conversations[0]}/events`);
    const tokenReader=tokenStream.body.getReader();await tokenReader.read();
    try {
      await sql('INSERT INTO clerk_revoked_sessions(session_id) VALUES($1)',['session_probe']);
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
    assert.equal((await request(tokens[0], `/api/sessions/${roomId}/repos`, "POST", { name: "Imported storefront", empty: true })).status, 409, "empty creation never finalizes an unfinished import");
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

    const emptyRoomId = "emptyproject";
    await sql(`INSERT INTO sessions(id,name,join_code,owner_id) VALUES ($1,'Conversation room','ABCD-VWXY',$2)`, [emptyRoomId, bob]);
    await sql(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'owner','owner'),($1,$3,'viewer','owner')`, [emptyRoomId, bob, alice]);
    const emptyEndpoint = `/api/sessions/${emptyRoomId}/repos`;
    for (const body of [{name:"",empty:true},{name:"x".repeat(101),empty:true},{name:"Invalid",empty:"yes"},{name:"Invalid",empty:true,projectRepositoryId:randomUUID()}]) {
      assert.equal((await request(tokens[1], emptyEndpoint, "POST", body)).status, 400);
    }
    assert.equal((await request(tokens[0], emptyEndpoint, "POST", {name:"Forbidden",empty:true})).status, 403);
    assert.equal((await request("not-a-session", emptyEndpoint, "POST", {name:"Forbidden",empty:true})).status, 401);
    const emptyResponse = await request(tokens[1], emptyEndpoint, "POST", {name:"  Ideas and questions  ",empty:true});
    assert.equal(emptyResponse.status, 200);
    const emptyRepo = (await emptyResponse.json()).repo;
    assert.equal(emptyRepo.rootName, "Ideas and questions");
    assert.equal(emptyRepo.upstreamUrl, null);
    assert.equal(emptyRepo.projectRepositoryId, null);
    assert.ok(emptyRepo.seededAt && emptyRepo.headSha);
    assert.equal((await request(tokens[1], emptyEndpoint, "POST", {name:emptyRepo.rootName,empty:true})).status, 409);
    const emptyTree = await request(tokens[0], `/api/sessions/${emptyRoomId}/tree?repoId=${emptyRepo.id}`);
    assert.equal(emptyTree.status, 200);
    assert.deepEqual((await emptyTree.json()).root.children, []);
    assert.equal((await (await request(tokens[1], emptyEndpoint)).json()).repos[0].id, emptyRepo.id);
    assert.equal((await request(tokens[1], `/api/sessions/${roomId}/tree?repoId=${emptyRepo.id}`)).status, 404);
    console.log("  ok empty project API: zero files, persistence, name validation, duplicate protection, and viewer/anonymous refusal");

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
      if (message.method === "Runtime.exceptionThrown") {
        const description = message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text;
        // The one consequence of blocking Clerk's script on purpose (CLERK_FRONTEND).
        if (!String(description).includes('code="failed_to_load_clerk_js"')) runtimeErrors.push(description);
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? "").join(" "));
      }
    });
    async function tab(token, targetRoom = roomId, readySelector = 'aside[aria-label="Repositories and chats"]', initScript) {
      const { browserContextId } = await send("Target.createBrowserContext");
      const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const command = (method, params) => send(method, params, sessionId);
      await command("Page.enable"); await command("Runtime.enable"); await command("Network.enable");
      // Keep the browser off Clerk's real servers. Its script would otherwise
      // load from the fixture key's internet domain, be refused there, and may
      // sign this tab out at a timing-dependent moment. The server still checks
      // every request's session with the fixture, which is what these tests cover.
      const block = (urls = []) => command("Network.setBlockedURLs", { urls: [...CLERK_FRONTEND, ...urls] });
      await block();
      await command("Page.bringToFront");
      if (initScript) await command("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
      await command("Network.setCookie", { name: "__client_uat", value: "1", url: server });
      await command("Network.setCookie", { name: "__clerk_db_jwt", value: "fixture", url: server });
      await command("Network.setCookie", { name: "__session", value: token, url: server, httpOnly: true, sameSite: "Lax" });
      await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
      const evaluate = async expression => {
        lastSessionId = sessionId;
        const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      // CDP acknowledges navigation before the previous document is replaced.
      // Its matching selectors (and sessionStorage) must not satisfy readiness.
      const changeDocument = async (method, params) => {
        await command("Page.bringToFront");
        const previous = await evaluate("performance.timeOrigin");
        await command(method, params);
        await eventually(() => evaluate(`performance.timeOrigin !== ${JSON.stringify(previous)} && document.readyState === 'complete'`), `${method} commits a new document`);
      };
      const navigate = url => changeDocument("Page.navigate", { url });
      const reload = () => changeDocument("Page.reload", {});
      const click = text => eventually(() => evaluate(`(() => { const scope = document.querySelector('dialog[open]') ?? document; const button = Array.from(scope.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)} && button.checkVisibility() && !button.disabled); if (!button) return false; button.click(); return true; })()`), `click ${text}`);
      await navigate(`${server}/s/${targetRoom}`);
      try {
        await eventually(() => evaluate(`!!document.querySelector(${JSON.stringify(readySelector)})`), "room workspace");
      } catch (cause) {
        console.error(await evaluate("document.body.innerText.slice(0, 5000)"), runtimeErrors);
        throw cause;
      }
      const selectRepository = label => eventually(() => evaluate(`(() => { const button=Array.from(document.querySelectorAll('.room-sidebar button')).find(button=>button.getAttribute('aria-label')===${JSON.stringify('New chat in '+label)}); if (!button) return false;button.click();return true; })()`), `repository ${label}`);
      const selectPicker = async (label, value) => {
        await command("Page.bringToFront");
        await eventually(()=>evaluate(`(() => {const button=Array.from(document.querySelectorAll('button')).find(button=>button.getAttribute('aria-label')===${JSON.stringify(label)});if(!button||button.disabled||!button.checkVisibility())return false;button.scrollIntoView({block:'nearest'});button.focus();button.click();return true;})()`),`enabled picker ${label}`);
        await eventually(()=>evaluate(`(() => {const button=Array.from(document.querySelectorAll('.composer-picker [role="option"]')).find(button=>button.value===${JSON.stringify(value)});if(!button||!button.checkVisibility())return false;button.click();return true;})()`),`picker option ${value}`);
      };
      return { command, block, evaluate, navigate, reload, click, selectRepository, selectPicker, targetId, sessionId };
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
    // The room sidebar is ready before the linked conversation has loaded.
    // Hold its response so this test always exercises that distinction.
    const assigner = await tab(tokens[1], `${roomId}?run=${chat.id}`, undefined, `(() => {
      const originalFetch = window.fetch;
      window.fetch = async (input, init) => {
        const response = await originalFetch.call(window, input, init);
        if (input === ${JSON.stringify(`/api/sessions/${roomId}/runs/${chat.id}`)}) {
          window.fetch = originalFetch;
          await new Promise(resolve => { window.__releaseLinkedChat = resolve; });
        }
        return response;
      };
    })()`);
    await eventually(() => assigner.evaluate('typeof window.__releaseLinkedChat === "function"'), "linked chat response held");
    assert.notEqual(await assigner.evaluate("document.querySelector('.ai-chat-header h2')?.textContent"), chat.title);
    await assigner.evaluate('window.__releaseLinkedChat(); delete window.__releaseLinkedChat');
    await eventually(() => assigner.evaluate(`document.querySelector('.ai-chat-header h2')?.textContent === ${JSON.stringify(chat.title)}`), "linked chat entered");
    await assigner.click("Assign Tasks");
    const aliceHandle = (await sql(`SELECT handle FROM users WHERE id=$1`,[alice])).rows[0].handle;
    const taskText = "Please review the changes in this shared chat.";
    const assignerHandle=(await sql('SELECT handle FROM users WHERE id=$1',[bob])).rows[0].handle;
    const taskSelector = 'dialog[aria-label="Assign Tasks"] textarea';
    const writeAssignment = async (view, text) => {
      await view.evaluate(`(() => {const input=document.querySelector(${JSON.stringify(taskSelector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    };
    await writeAssignment(assigner, '@');
    await eventually(()=>assigner.evaluate(`Array.from(document.querySelectorAll('dialog button')).some(button=>button.textContent.includes(${JSON.stringify('@'+aliceHandle+' ·')}))`),"room member picker");
    assert.equal(await assigner.evaluate(`Array.from(document.querySelectorAll('dialog button')).some(button=>button.textContent.includes(${JSON.stringify('@'+assignerHandle+' ·')}))`),false);
    await assigner.evaluate(`Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent.includes(${JSON.stringify('@'+aliceHandle+' ·')})).click()`);
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
    await writeAssignment(assigner, '@'+aliceHandle+' '+taskText);
    // A failed delivery keeps the draft intact so the user can retry.
    await assigner.command("Network.enable",{});
    await assigner.block(["*/api/tasks"]);
    await assigner.click("Assign task");
    await eventually(() => assigner.evaluate('!!document.querySelector(\'dialog[aria-label="Assign Tasks"] [role="alert"]\')'), "task delivery failure");
    assert.equal(await assigner.evaluate('document.querySelector(\'dialog[aria-label="Assign Tasks"] textarea\').value'),'@'+aliceHandle+' '+taskText);
    await assigner.block([]);
    await assigner.click("Assign task");
    await eventually(() => assigner.evaluate('document.querySelector(\'dialog[aria-label="Assign Tasks"] [role="status"]\')?.textContent.includes("Task assigned")'), "task assignment confirmation");
    await assigner.evaluate(`document.querySelector('button[aria-label="Close Assign Tasks"]').click()`);
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
    await inbox.navigate(`${server}/workspace`);
    await eventually(() => inbox.evaluate(`document.querySelector('section[aria-label="My tasks"]')?.textContent.includes(${JSON.stringify(taskText)})`), "assignee dashboard inbox");
    await inbox.selectPicker(`Status for ${taskText.slice(0,60)}`, "done");
    await eventually(async () => (await sql(`SELECT status FROM room_tasks WHERE id=$1`,[stored[0].id])).rows[0].status === "done", "task completion saved");
    await inbox.evaluate('document.querySelector(\'section[aria-label="My tasks"] a\').click()');
    // A chat's tasks open from Tasks in its nav.
    await eventually(() => inbox.evaluate(`(()=>{if(!document.querySelector('section[aria-label="Chat tasks"]'))[...document.querySelectorAll('nav[aria-label="Chat"] button')].find(b=>b.textContent.trim().startsWith("Tasks"))?.click();})(); location.search === ${JSON.stringify(`?run=${chat.id}`)} && document.querySelector('section[aria-label="Chat tasks"]')?.textContent.includes(${JSON.stringify(taskText)})`), "task source chat deep link");
    // A session the server rejects on the dashboard leads to the sign-in page,
    // not a crash. /workspace is prerendered; when that happened without the
    // publishable key (as in CI builds), a client-side route change to /login
    // kept a layout with no Clerk provider and the sign-in form threw.
    const signedOutToken = await clerk.link({ query: sql }, alice, { sessionId: "session_signed_out" });
    await sql("INSERT INTO clerk_revoked_sessions(session_id) VALUES($1)", ["session_signed_out"]);
    const errorsBefore = runtimeErrors.length;
    const signedOut = await tab(signedOutToken, roomId, "body");
    await signedOut.navigate(`${server}/workspace`);
    await eventually(() => signedOut.evaluate(`location.pathname === "/login" && new URLSearchParams(location.search).get("next") === "/workspace" && document.readyState === "complete"`), "signed-out dashboard opens sign-in");
    await delay(500);
    assert.equal(await signedOut.evaluate(`document.body.innerText.includes("couldn’t load")`), false, "sign-in page renders instead of an error page");
    assert.deepEqual(runtimeErrors.slice(errorsBefore), [], "no exception while leaving for sign-in");
    await assigner.command("Page.bringToFront");
    await assigner.evaluate('window.dispatchEvent(new Event("focus"))');
    await eventually(() => assigner.evaluate(`(()=>{if(!document.querySelector('section[aria-label="Chat tasks"]'))[...document.querySelectorAll('nav[aria-label="Chat"] button')].find(b=>b.textContent.trim().startsWith("Tasks"))?.click();})(); document.querySelector('section[aria-label="Chat tasks"] button[aria-label^="Status for"]')?.textContent === "Done"`), "status refresh in source chat");
    // The File Manager assignment dialog works without running AI.
    await assigner.click("Assign Tasks");
    const composerSelector = taskSelector;
    const setComposer = text => assigner.evaluate(`(() => {
      const textarea=document.querySelector(${JSON.stringify(composerSelector)});
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,${JSON.stringify(text)});
      textarea.setSelectionRange(textarea.value.length,textarea.value.length);
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await eventually(()=>assigner.evaluate(`!!document.querySelector(${JSON.stringify(composerSelector)})`),"task composer for non-driver");
    await setComposer('@');
    await eventually(()=>assigner.evaluate('[...document.querySelectorAll("[popover]")].some(p=>p.matches(":popover-open") && p.textContent.startsWith("People") && p.textContent.includes("Assign task"))'),"people mention picker");
    // The list sits in the top layer, entirely on screen: the dialog's scrolling body no longer clips it.
    const picker = await assigner.evaluate('(()=>{const p=[...document.querySelectorAll("[popover]")].find(e=>e.matches(":popover-open"));if(!p)return null;const r=p.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,rows:p.querySelectorAll("li").length};})()');
    assert.ok(picker && picker.top >= 0 && picker.bottom <= picker.height && picker.rows >= 1, `the mention list is fully visible: ${JSON.stringify(picker)}`);
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
    await assigner.block(["*/api/tasks"]);
    await assigner.evaluate(`document.querySelector('button[aria-label="Assign task"]').click()`);
    await eventually(()=>assigner.evaluate(`document.querySelector(${JSON.stringify(composerSelector)}).disabled === false && document.body.innerText.includes("Failed to fetch")`),"failed task keeps composer draft");
    assert.equal(await assigner.evaluate(`document.querySelector(${JSON.stringify(composerSelector)}).value`),'@'+aliceHandle+' '+taggedTask);
    await assigner.block([]);
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
    const fresh = await tab(tokens[0], roomId, undefined, `(() => {
      const originalFetch=window.fetch.bind(window);
      const gate=new Promise(resolve=>{window.__releaseTaskRoster=resolve;});
      window.__pendingTaskRosters=0;
      window.fetch=async(input,init)=>{
        const url=new URL(typeof input==='string'?input:input.url,location.origin);
        const response=await originalFetch(input,init);
        if(url.pathname==='/api/tasks' && url.searchParams.has('sessionId') && !url.searchParams.has('runId')) {
          window.__pendingTaskRosters++;await gate;
        }
        return response;
      };
    })()`);
    await fresh.selectRepository("Imported storefront");
    await fresh.click("Assign Tasks");
    const freshSelector=taskSelector;
    const writeFresh = text => fresh.evaluate(`(() => {
      const textarea=document.querySelector(${JSON.stringify(freshSelector)});
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,${JSON.stringify(text)});
      textarea.setSelectionRange(textarea.value.length,textarea.value.length);
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await eventually(()=>fresh.evaluate(`!!document.querySelector(${JSON.stringify(freshSelector)}) && !document.querySelector('section[aria-label="Chat tasks"]')`),"fresh chat task composer");
    await eventually(()=>fresh.evaluate('window.__pendingTaskRosters>0'),'delayed task roster requested');
    const bobHandle=(await sql('SELECT handle FROM users WHERE id=$1',[bob])).rows[0].handle;
    await writeFresh('@');
    assert.equal(await fresh.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes(${JSON.stringify('@'+bobHandle+' ·')}) && button.textContent.includes('Assign task'))`),false);
    await fresh.evaluate('window.__releaseTaskRoster()');
    await eventually(()=>fresh.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes(${JSON.stringify('@'+bobHandle+' ·')}) && button.textContent.includes('Assign task'))`),"people arrive after typing without another keystroke");
    assert.ok(await fresh.evaluate('[...document.querySelectorAll("[popover]")].some(p=>p.matches(":popover-open") && p.textContent.startsWith("People"))'));
    assert.equal(await fresh.evaluate(`Array.from(document.querySelectorAll('button')).some(button=>button.textContent.includes(${JSON.stringify('@'+aliceHandle+' ·')}) && button.textContent.includes('Assign task'))`),false);
    const preview=await fresh.command("Page.captureScreenshot",{format:"png"});
    await writeFile(join(tmpdir(), "new-chat-task-picker.png"),Buffer.from(preview.data,"base64"));
    await fresh.evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes(${JSON.stringify('@'+bobHandle+' ·')}) && button.textContent.includes('Assign task')).click()`);
    const freshBody='Please review the imported storefront before we begin.';
    await writeFresh('@'+bobHandle+' '+freshBody);
    const chatCount=(await sql('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n;
    const turnCount=(await sql('SELECT count(*)::int AS n FROM agent_turns')).rows[0].n;
    await fresh.command("Network.enable",{});
    await fresh.block(["*/api/tasks"]);
    await fresh.evaluate(`document.querySelector('button[aria-label="Assign task"]').click()`);
    await eventually(()=>fresh.evaluate('document.body.textContent.includes("Failed to fetch")'),"fresh task send failure");
    assert.equal(await fresh.evaluate(`document.querySelector(${JSON.stringify(freshSelector)}).value`),'@'+bobHandle+' '+freshBody);
    assert.equal((await sql('SELECT count(*)::int AS n FROM agent_runs')).rows[0].n,chatCount);
    await fresh.block([]);
    await fresh.evaluate(`document.querySelector('button[aria-label="Assign task"]').click()`);
    await eventually(()=>fresh.evaluate(`(()=>{if(!document.querySelector('section[aria-label="Chat tasks"]'))[...document.querySelectorAll('nav[aria-label="Chat"] button')].find(b=>b.textContent.trim().startsWith("Tasks"))?.click();})(); document.querySelector('section[aria-label="Chat tasks"]')?.textContent.includes(${JSON.stringify(freshBody)})`),"new source chat opens with assigned task");
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
      await eventually(() => view.evaluate('document.querySelector(".room-sidebar")?.checkVisibility()'), "project sidebar visible");
      await view.evaluate(`(() => {const button=Array.from(document.querySelectorAll('.room-sidebar button[aria-expanded]')).find(button=>button.textContent.includes('Platform'));if(button.getAttribute('aria-expanded')==='false')button.click();button.click();})()`);
      await eventually(()=>view.evaluate(`!document.querySelector('button[title^="Browser handoff ·"]')`),"repository collapses");
      await view.evaluate(`Array.from(document.querySelectorAll('.room-sidebar button[aria-expanded]')).find(button=>button.textContent.includes('Platform')).click()`);
      await eventually(()=>view.evaluate(`!!document.querySelector('button[title^="Browser handoff ·"]')`),"repository expands");
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
    await eventually(() => recipient.evaluate('!!document.querySelector(\'button[aria-label="Provider"]\')'), "discovered multi-provider execution option");
    await recipient.selectPicker("Provider", 'opencode');
    await recipient.evaluate('document.querySelector(\'button[aria-label="Choose model"]\').click()');
    await eventually(() => recipient.evaluate('document.querySelector(".composer-picker")?.textContent.includes("test-provider/release-one")'), "runner model discovery in picker");
    await recipient.evaluate('Array.from(document.querySelectorAll(".composer-picker button")).find(button => button.textContent.includes("test-provider/release-one")).click()');
    assert.equal(JSON.stringify(await (await request(tokens[0], "/api/ai/agents")).json()).includes("test-provider/release-one"), false, "Runner model catalogs are scoped to their owner");
    await advertise("test-provider/release-two");
    await recipient.evaluate('window.dispatchEvent(new Event("focus"))');
    await eventually(() => recipient.evaluate('document.querySelector(\'button[aria-label="Choose model"]\')?.textContent.includes("Unavailable: test-provider/release-one")'), "removed model stays pinned but is unavailable");
    const removed = await request(tokens[1], "/api/ai/run", "POST", { sessionId: roomId, agentId: "opencode", model: "test-provider/release-one", prompt: "Do not execute unavailable models" });
    assert.equal(removed.status, 409);
    await recipient.evaluate('document.querySelector(\'button[aria-label="Choose model"]\').click()');
    await eventually(() => recipient.evaluate('document.querySelector(".composer-picker")?.textContent.includes("test-provider/release-two")'), "new release appears without a code update");
    await recipient.evaluate('Array.from(document.querySelectorAll(".composer-picker button")).find(button => button.textContent.includes("test-provider/release-two")).click()');
    await recipient.selectPicker("Provider", 'codex');
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
    await sender.click("Handoff");
    await sender.selectPicker("Handoff recipient", bob);
    await sender.evaluate(`(() => { const note = document.querySelector('dialog textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(note, 'Continue the accessible checkout'); note.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sender.evaluate("document.querySelector('dialog form').requestSubmit()");
    await eventually(() => recipient.evaluate("document.body.textContent.includes('Open handoff')"), "recipient inbox");
    await recipient.click("Open handoff");
    await recipient.click("Handoff");
    await eventually(() => recipient.evaluate("document.body.textContent.includes('Accept control')"), "recipient offer via live API");
    await recipient.click("Accept control");
    await eventually(() => recipient.evaluate(`document.querySelector('section[aria-label="Chat control"]')?.title.includes('bob is driving')`), "recipient owns chat");
    await eventually(() => sender.evaluate(`document.querySelector('section[aria-label="Chat control"]')?.title.includes('bob is driving')`), "sender control invalidation");
    console.log("  ok two independent browsers offer and accept a handoff using the real API and event bus");

    await recipient.selectRepository("Imported storefront");
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
    await eventually(() => recipient.evaluate('document.querySelector(\'button[aria-label="File: src/checkout.ts"]\')?.checkVisibility()'), "mobile return to explorer");
    await recipient.evaluate('document.querySelector(\'button[aria-label="File: src/checkout.ts"]\').click()');
    await eventually(() => recipient.evaluate('document.querySelector(".room-file-document")?.checkVisibility()'), "mobile file editor");
    await recipient.reload();
    await eventually(() => recipient.evaluate(`sessionStorage.getItem('room-repository:${roomId}') === ${JSON.stringify(imported.id)} && document.querySelector('button[aria-label="File: src/checkout.ts"]')?.checkVisibility()`), "reopened room restores imported repository and visible files");
    console.log("  ok persistent explorer, folder-path search, refresh, mobile navigation, and repository restoration");
    const uploadStarted = performance.now();
    await eventually(() => recipient.evaluate('!!document.querySelector(\'input[aria-label="Import repository folder"]\')'), "folder import input after reload");
    await recipient.evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Import repository folder"]');
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
    await eventually(() => recipient.evaluate("!!document.querySelector('button[aria-label=\"New chat in Browser upload\"]') && document.body.textContent.includes('uploaded.ts')"), "automatic file selection after folder upload");
    const uploadMs = Math.round(performance.now() - uploadStarted);
    const browserRepoId = await recipient.evaluate(`sessionStorage.getItem('room-repository:${roomId}')`);
    const teammateFile = await request(tokens[0], `/api/sessions/${roomId}/file?repoId=${browserRepoId}&path=bulk/file999.txt`);
    assert.equal(teammateFile.status, 200);
    assert.equal((await teammateFile.json()).text, 'contents 999');
    console.log(`  ok browser uploads 1,001 files, selects the repository, and makes contents available to a teammate (${uploadMs} ms)`);

    const freshRoom = "freshbrowser";
    await sql(`INSERT INTO sessions(id,name,join_code,owner_id) VALUES ($1,'Fresh folder room','ABCD-RSTU',$2)`, [freshRoom, alice]);
    await sql(`INSERT INTO session_members(session_id,user_id,role,added_via) VALUES ($1,$2,'owner','owner')`, [freshRoom, alice]);
    await createRepo(freshRoom);
    const fresh = await tab(tokens[0], freshRoom, 'input[aria-label="Upload initial folder"]');
    async function upload(view, inputLabel, root, path, contents) {
      const selector = `input[aria-label="${inputLabel}"]`;
      await eventually(() => view.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `folder input: ${inputLabel}`);
      await view.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        const file = new File([${JSON.stringify(contents)}], ${JSON.stringify(path.split("/").at(-1))}, { type: "text/plain" });
        Object.defineProperty(file, 'webkitRelativePath', { value: ${JSON.stringify(root + "/" + path)} });
        const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    }
    await upload(fresh, "Upload initial folder", "First project", "src/first.ts", "export const first = true;");
    await eventually(() => fresh.evaluate('document.querySelector(\'button[aria-label="File: src/first.ts"]\')?.checkVisibility()'), "initial project upload appears without reload");
    await upload(fresh, "Import repository folder", "Second project", "lib/second.ts", "export const second = true;");
    await eventually(() => fresh.evaluate('document.querySelector(\'button[aria-label="File: lib/second.ts"]\')?.checkVisibility()'), "additional import in freshly seeded room");
    await fresh.selectRepository("First project");
    await eventually(() => fresh.evaluate('document.querySelector(\'button[aria-label="File: src/first.ts"]\')?.checkVisibility() && !document.querySelector(\'button[aria-label="File: lib/second.ts"]\')'), "switching back loads original repository");
    await fresh.command("Network.enable", {});
    await fresh.block([`*/api/sessions/${freshRoom}/file?*`]);
    await fresh.evaluate('document.querySelector(\'button[aria-label="File: src/first.ts"]\').click()');
    await eventually(() => fresh.evaluate('document.body.textContent.includes("Retry file")'), "failed file read exits loading with retry");
    await fresh.block([]);
    await fresh.click("Retry file");
    await eventually(() => fresh.evaluate('Array.from(document.querySelectorAll("textarea")).some(input => input.value.includes("export const first"))'), "retry opens file successfully");
    await fresh.block([`*/api/sessions/${freshRoom}/tree?*`]);
    await fresh.evaluate('document.querySelector(\'button[aria-label="Refresh files"]\').click()');
    await eventually(() => fresh.evaluate('!!document.querySelector(\'aside[aria-label="Repository explorer"] [role="alert"]\')'), "tree refresh failure is visible rather than silently empty");
    await fresh.block([]);
    await fresh.evaluate('document.querySelector(\'button[aria-label="Refresh files"]\').click()');
    await eventually(() => fresh.evaluate('!document.querySelector(\'aside[aria-label="Repository explorer"] [role="alert"]\') && document.querySelector(\'button[aria-label="File: src/first.ts"]\')?.checkVisibility()'), "tree retry preserves visible project files");
    console.log("  ok fresh-room uploads, second import, switching back, and recovery from real blocked file/tree requests");

    const deviceToken = randomBytes(32).toString("base64url");
    await sql(`INSERT INTO runner_devices(user_id,name,token_hash,version,agent_ids,last_seen_at,supports_inputs) VALUES ($1,'Simulated Bob runner',$2,'2',ARRAY['codex'],now(),true)`, [bob, createHash("sha256").update(deviceToken).digest()]);
    const runnerRequest = (path, body) => fetch(`${server}${path}`, { method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    let emptyRunId;
    for (const makeFile of [false, true]) {
      const prompt = makeFile ? "Save our idea as a note." : "Help me brainstorm a weekend plan.";
      const stream = await request(tokens[1], "/api/ai/run", "POST", {sessionId:emptyRoomId,repoId:emptyRepo.id,agentId:"codex",prompt,turnId:randomUUID(),...(emptyRunId ? {runId:emptyRunId,controlVersion:0} : {})});
      assert.equal(stream.status, 200);
      const streamText = readRunStream(stream);
      const {job} = await (await runnerRequest("/api/runner/claim", {version:"2",waitMs:0})).json();
      assert.equal(job.repoId, emptyRepo.id);
      emptyRunId = job.runId;
      const runnerGit = new RunnerGit(server, deviceToken, join(directory, "empty-project-runner"));
      const resultSha = await runnerGit.withWorkspace(job, async workspace => {
        assert.deepEqual((await readdir(workspace.path)).filter(name=>name!==".git"), [], "no uploaded or template files are required");
        if(makeFile) await writeFile(join(workspace.path,"notes.txt"),"Take a walk and sketch ideas.\n");
        return workspace.commitAndPush("Conversation note", job.author);
      });
      if(!makeFile) assert.equal(resultSha, null, "normal conversation completes without file changes");
      const report={code:0,resultSha,output:makeFile?"Saved your note.":"Let’s plan a relaxing weekend.",errOutput:"",ms:5};
      assert.equal((await runnerRequest(`/api/runner/runs/${job.turnId}/complete`,report)).status,200);
      assert.match(await streamText,/"t":"exit"/);
      const saved=await (await request(tokens[1],`/api/sessions/${emptyRoomId}/runs/${emptyRunId}`)).json();
      assert.equal(saved.run.repoId,emptyRepo.id);
      assert.ok(saved.messages.some(message=>message.body.includes(report.output)), "conversation is saved without an uploaded folder");
    }
    assert.equal((await (await request(tokens[1],`/api/sessions/${emptyRoomId}/file?repoId=${emptyRepo.id}&path=notes.txt`)).json()).text,"Take a walk and sketch ideas.\n");
    const emptyView=await tab(tokens[1],`${emptyRoomId}?run=${emptyRunId}`);
    await eventually(()=>emptyView.evaluate('document.body.textContent.includes("Let’s plan a relaxing weekend.") && document.body.textContent.includes("Saved your note.")'),"empty project conversation survives reopening");
    console.log("  ok empty project runs: no-file conversation, saved history, follow-up file creation, and reopening through real APIs");
    const denied = await request(tokens[0], "/api/ai/run", "POST", { sessionId: roomId, agentId: "codex", runId: chat.id, controlVersion: 0, prompt: "Stale driver" });
    assert.equal(denied.status, 409);
    for (let index = 0; index < 2; index += 1) {
      const stream = await request(tokens[1], "/api/ai/run", "POST", { sessionId: roomId, agentId: "codex", runId: chat.id, controlVersion: 1, prompt: `Continue step ${index}`, turnId: randomUUID() });
      if (!stream.ok) throw new Error(`Run failed: ${stream.status} ${await stream.text()}`);
      const streamText = readRunStream(stream);
      const claim = await runnerRequest("/api/runner/claim", { version: "2", waitMs: 0 });
      const { job } = await claim.json();
      assert.ok(job);
      assert.equal(job.runId, chat.id);
      assert.match(job.agentPrompt, /Continue the accessible checkout/);
      if (index === 0) {
        await recipient.navigate(`${server}/s/${roomId}?run=${chat.id}`);
        await eventually(() => recipient.evaluate(`!!document.querySelector('textarea[aria-label="Message working agent"]')`), "working agent queue composer");
        const message = "Also verify keyboard navigation while working";
        const inputEndpoint=`/api/sessions/${roomId}/runs/${chat.id}/inputs`;
        const queuedMessageVisible = () => recipient.evaluate(`Array.from(document.querySelectorAll('[aria-label="Chat message queue"] li p')).some(entry => entry.textContent === ${JSON.stringify(message)})`);
        // Hold the POST before it reaches the server: a React textarea can
        // contain the draft in textContent while the UI still says Queuing….
        await recipient.evaluate(`(() => {
          const originalFetch = window.fetch;
          window.fetch = async (input, init) => {
            if (input === ${JSON.stringify(inputEndpoint)} && init?.method === 'POST') {
              window.fetch = originalFetch;
              await new Promise(resolve => { window.__releaseQueuedInput = resolve; });
            }
            return originalFetch.call(window, input, init);
          };
        })()`);
        await recipient.evaluate(`(() => { const input=document.querySelector('textarea[aria-label="Message working agent"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(message)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await recipient.click("Queue message");
        await eventually(() => recipient.evaluate('typeof window.__releaseQueuedInput === "function"'), "queue POST held before delivery");
        assert.equal(await queuedMessageVisible(), false, "the unsent draft must not satisfy queue readiness");
        assert.equal((await (await runnerRequest(`/api/runner/runs/${job.turnId}/inputs`,{kind:"claim",claimId:randomUUID()})).json()).input,null,"runner cannot claim an unsent draft");
        await recipient.evaluate('window.__releaseQueuedInput(); delete window.__releaseQueuedInput');
        await eventually(queuedMessageVisible, "persisted instruction appears in the queue");
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
    assert.equal(interrupted.status,200); const interruptedOutput=readRunStream(interrupted);
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
    // Open history while its initial response is still in flight. Resubscribing
    // must not discard that response and leave the dialog permanently empty.
    await recipient.command("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
      const originalFetch = window.fetch;
      window.fetch = async (input, init) => {
        const response = await originalFetch.call(window, input, init);
        if (input === ${JSON.stringify(historyUrl)} && (!init?.method || init.method === 'GET')) {
          window.fetch = originalFetch;
          await new Promise(resolve => { window.__releaseInitialHistory = resolve; });
        }
        return response;
      };
    })()` });
    await recipient.navigate(`${server}/s/${roomId}?run=${chat.id}`);
    await eventually(()=>recipient.evaluate('typeof window.__releaseInitialHistory === "function"'),"initial history response held");
    await eventually(()=>recipient.evaluate(`!!Array.from(document.querySelectorAll('nav[aria-label="Chat"] button')).find(b=>b.textContent.trim()==="Activity")`),"workspace history in the chat's nav");
    await recipient.click("Activity");
    await eventually(()=>recipient.evaluate('!!document.querySelector(\'dialog[aria-label="Synchronized workspace history"]\')'),"history opens during its initial request");
    await recipient.evaluate('window.__releaseInitialHistory(); delete window.__releaseInitialHistory');
    await eventually(()=>recipient.evaluate(`document.querySelector('button[aria-label="Code checkpoint"]')?.disabled === false`),"uploaded checkpoint visible");
    await recipient.selectPicker("Code checkpoint", checkpoint.id);
    await eventually(()=>recipient.evaluate('document.querySelector("dialog")?.textContent.includes("unfinished.txt")'),"offline checkpoint files");
    await recipient.click("A unfinished.txt");
    await eventually(()=>recipient.evaluate('document.querySelector("dialog pre")?.textContent.includes("Available after laptop shutdown")'),"checkpoint diff displayed");
    const historyScreenshot=await recipient.command("Page.captureScreenshot",{format:"png"});
    await writeFile(join(tmpdir(), "workspace-history.png"),Buffer.from(historyScreenshot.data,"base64"));
    await recipient.evaluate(`document.querySelector('button[aria-label="Close Synchronized workspace history"]').click()`);
    console.log("  ok real checkpoint push/report, durable activity retry/replay, offline diff browsing, driver-only restore selection, and history UI");
    assert.deepEqual(runtimeErrors, []);
    console.log("  ok real run/claim/smart-HTTP/completion APIs: two successive turns on recipient device, duplicate completion, old-driver refusal");

    // A terminal on Bob's own computer through the real server and Redis: the
    // runner's own API receives terminal.open on its event stream, runs a real
    // shell, and posts output back; only Bob's browser stream receives it.
    await sql(`UPDATE runner_devices SET supports_terminal = true, last_seen_at = now() WHERE token_hash = $1`, [createHash("sha256").update(deviceToken).digest()]);
    const runnerApi = new RunnerApi(server, deviceToken);
    const terminalHost = new TerminalHost(report => runnerApi.terminal(report), async () => ({ path: directory, label: "room worktree" }), { shell: "/bin/sh" });
    const stopSignals = new AbortController();
    const signalsDone = runnerApi.signals(stopSignals.signal, (type, data) => { if (type.startsWith("terminal.")) terminalHost.handle(type, data); }).catch(() => {});
    try {
      await delay(500);
      const terminalId = randomUUID();
      const stream = await fetch(`${server}/api/terminal/pty?id=${terminalId}&cols=90&rows=24&sessionId=${roomId}`, { headers: { cookie: clerkCookie(tokens[1]) } });
      assert.equal(stream.status, 200);
      const reader = stream.body.getReader(), decoder = new TextDecoder();
      let buffer = "", shown = "", exited = false;
      const readUntil = async (done, label) => {
        const deadline = Date.now() + 15_000;
        while (!done()) {
          if (Date.now() > deadline) throw new Error(`Timed out: terminal ${label}; saw ${JSON.stringify(shown.slice(-400))}`);
          const { value, done: ended } = await Promise.race([reader.read(), delay(1000).then(() => ({ value: undefined, done: false }))]);
          if (ended) break;
          if (!value) continue;
          buffer += decoder.decode(value, { stream: true });
          for (let end; (end = buffer.indexOf("\n\n")) >= 0; buffer = buffer.slice(end + 2)) {
            const frame = buffer.slice(0, end), type = /^event: (.*)$/m.exec(frame)?.[1], data = /^data: (.*)$/m.exec(frame)?.[1] ?? "";
            if (type === "exit") exited = true;
            else if (type === "notice") shown += JSON.parse(data) + "\n";
            else if (!type && data) shown += Buffer.from(data, "base64").toString();
          }
        }
      };
      await readUntil(() => shown.includes("Terminal · room worktree"), "announces where it opened, briefly");
      assert.equal(shown.includes(directory), false, "the notice names the worktree, not its full path");
      const terminalPost = (token, body) => request(token, `/api/terminal/pty?id=${terminalId}`, "POST", { id: terminalId, ...body });
      assert.equal((await terminalPost(tokens[1], { type: "input", data: "pwd\r" })).status, 204);
      await readUntil(() => shown.includes(directory), "opens in the worktree on Bob's computer");
      assert.equal((await terminalPost(tokens[1], { type: "input", data: "echo through-the-relay-$((6*7))\r" })).status, 204);
      await readUntil(() => shown.includes("through-the-relay-42"), "relays keystrokes and output");
      await terminalPost(tokens[0], { type: "input", data: "echo alice-was-here\r" });
      await terminalPost(tokens[1], { type: "input", data: "echo bob-again\r" });
      await readUntil(() => shown.includes("bob-again"), "keeps working");
      assert.equal(shown.includes("alice-was-here"), false, "another member cannot type into Bob's terminal");
      await terminalPost(tokens[1], { type: "kill" });
      await readUntil(() => exited, "reports the shell's exit");
      await reader.cancel().catch(() => {});
    } finally {
      stopSignals.abort();
      terminalHost.closeAll();
      await signalsDone;
    }
    console.log("  ok terminal on the member's computer through the real server: runner event stream, relay, isolation and exit");
    assert.equal((await request(tokens[0], "/api/orgs", "POST", { name: "UX workshop", slug: "ux-workshop" })).status, 201);
    await Promise.all([
      fetch(server),
      ...["/api/orgs/ux-workshop/projects", "/api/orgs/ux-workshop/usage", "/api/chat/conversations?org=ux-workshop", "/api/invitations", "/api/runner/devices"].map(path => request(tokens[0], path)),
    ]);
    await sender.navigate(`${server}/workspace`);
    await eventually(() => sender.evaluate('!!document.querySelector(\'button[aria-label="Switch organization"]:not([disabled])\')'), "organization switcher");
    await sender.evaluate('document.querySelector(\'button[aria-label="Switch organization"]\').click()');
    await eventually(() => sender.evaluate('!!document.querySelector(\'[role=menuitemradio][title="UX workshop"]\')'), "organization navigation");
    await sender.evaluate('document.querySelector(\'[role=menuitemradio][title="UX workshop"]\').click()');
    await eventually(() => sender.evaluate('document.querySelector("main h1")?.textContent === "UX workshop"'), "guided project overview");
    assert.equal(await sender.evaluate('document.querySelector("dialog") === null'), true, "First visit does not interrupt onboarding with provider setup");
    await sender.click("New project");
    await eventually(() => sender.evaluate('document.querySelector("dialog")?.textContent.includes("add as many repositories as your work needs")'), "project setup");
    assert.equal(await sender.evaluate(`document.querySelector('dialog input[type="url"]') === null`), true, "A project does not bind a single repository");
    await sender.click("Cancel");
    await sender.command("Network.enable", {});
    await sender.block(["*/api/ai/agents*"]);
    await sender.evaluate('document.querySelector(\'button[aria-label="AI providers"]\').click()');
    await eventually(() => sender.evaluate('document.querySelector("dialog")?.textContent.includes("connect it first")'), "AI setup provides next steps");
    await eventually(() => sender.evaluate('!!document.querySelector("dialog [role=alert]")'), "AI setup failures surface with a retry");
    await sender.block([]);
    await sender.click("Check again");
    await eventually(() => sender.evaluate('!document.querySelector("dialog [role=alert]") && document.querySelectorAll("dialog li").length > 0'), "AI setup refresh recovers");
    await sender.block(["*/api/runner/devices*"]);
    await sender.click("Connect computer");
    await eventually(() => sender.evaluate('document.querySelector("dialog")?.textContent.includes("Connect a computer to send AI messages")'), "AI setup links to device pairing");
    await eventually(() => sender.evaluate('!!document.querySelector("dialog [role=alert]")'), "device loading failures are visible");
    await sender.block([]);
    await sender.click("Check connection again");
    await eventually(() => sender.evaluate('!document.querySelector("dialog [role=alert]") && !!document.querySelector("dialog [role=tablist]")'), "device loading retry recovers");
    await sender.click("Terminal (npx)");
    // Reconnecting needs no code: the start command is there before pairing.
    assert.equal(await sender.evaluate('!!document.querySelector(\'button[aria-label="Copy start command"]\')'), true);
    // The Terminal tab creates the pairing code by itself.
    await eventually(() => sender.evaluate('document.querySelector("dialog")?.textContent.includes("multicode-ai-runner pair")'), "standalone runner pairing instructions");
    const instructions = await sender.evaluate('document.querySelector("dialog").textContent');
    assert.ok(instructions.includes(`${server}/downloads/multicode-ai-runner.tgz`));
    assert.ok(instructions.includes('multicode-ai-runner start'));
    // The address carries the package's fingerprint, so npx fetches each new runner instead of a cached old one.
    const packageUrl = instructions.match(/npx --yes --package="([^"]+)" multicode-ai-runner pair/)?.[1];
    assert.match(packageUrl ?? "", new RegExp(`^${server.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/downloads/multicode-ai-runner\\.tgz\\?v=[0-9a-f]{12}$`));
    assert.equal((await fetch(packageUrl)).status, 200, "the fingerprinted address serves the package");
    assert.ok(!instructions.includes('npm install --global'));
    assert.equal(await sender.evaluate('!!document.querySelector(\'button[aria-label="Copy start command"]\')'), true);
    assert.ok(!instructions.includes('npm run runner'));
    const download = await fetch(`${server}/downloads/multicode-ai-runner.tgz`);
    assert.equal(download.status, 200);
    const artifact = new Uint8Array(await download.arrayBuffer());
    assert.deepEqual([...artifact.slice(0, 2)], [0x1f, 0x8b], 'download is the actual gzip package');
    await sender.click("Close");
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
    console.error("Browser integration failed:", cause);
    console.error("Browser exceptions:", runtimeErrors);
    console.error("Browser console errors:", consoleErrors.slice(-20));
    console.error("Next.js server output:", output.slice(-12000));
    if (lastSessionId) {
      const diagnostic = await send("Runtime.evaluate", { expression: "document.body?.innerText.slice(0, 5000)", returnByValue: true }, lastSessionId).catch(() => null);
      console.error("Last browser state:", diagnostic?.result?.value);
    }
    throw cause;
  } finally {
    await writeFile(join(tmpdir(), "handoff-browser-server.log"), output);
    socket?.close();
    await clerk.close();
    for (const child of [chrome, next]) {
      if (!child || child.exitCode !== null) continue;
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([stopped, delay(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
}
