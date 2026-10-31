/** Browser checks of parallel chats in the real workspace UI, with isolated in-browser API fixtures:
 * the composer's Parallel toggle, the sidebar's branch state, and reviewing,
 * merging and conflict handling in a parallel chat's Changes panel.
 * npm run test:workspace-ui starts an isolated development server.
 * PARALLEL_UI_BASE_URL=http://127.0.0.1:3106 node tests/parallel-chats.browser.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { installFixtures } from "./helpers/workspace-browser-fixture.mjs";

const base = process.env.PARALLEL_UI_BASE_URL ?? "http://127.0.0.1:3106";
let serverOutput = "";
const server = process.argv.includes("--start-server") ? spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", new URL(base).port], {
  env: { ...process.env, NEXT_TEST_DIST_DIR: ".next-handoff-test", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"],
}) : null;
server?.stdout.on("data", data => { serverOutput += data; });
server?.stderr.on("data", data => { serverOutput += data; });
const directory = await mkdtemp(join(tmpdir(), "multiplayer-parallel-ui-"));
const chrome = spawn(process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=9338", `--user-data-dir=${directory}`, "about:blank",
], { stdio: "ignore" });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(task, label) {
  for (let i = 0; i < 300; i++) { if (await task()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}

/** One parallel chat with changes to review, its branch state, a diff, and the server's next answers. */
function seedParallelChat() {
  const state = window.__model, sha = c => c.repeat(40);
  state.repos.push({ id: "frontendabcd", sessionId: "modelroomabc", rootName: "frontend", projectRepositoryId: "11111111-1111-4111-8111-111111111111",
    headSha: sha("b"), baseSha: sha("a"), seededAt: 1, createdAt: 1, createdBy: "alice" });
  const run = { id: "33333333-3333-4333-8333-333333333333", sessionId: "modelroomabc", repoId: "frontendabcd", startedBy: "alice", startedByName: "Alice",
    driverUserId: "alice", driverName: "Alice", controlVersion: 0, restoreSnapshotId: null, agentId: "codex", title: "Parallel login fix",
    status: "completed", baseSha: sha("a"), resultSha: sha("c"), addedLines: 3, removedLines: 1, exitCode: 0, error: null,
    createdAt: Date.now() - 60000, startedAt: Date.now() - 60000, endedAt: Date.now() - 30000, archivedAt: null,
    isolation: "isolated", forkSha: sha("a"), headSha: sha("c"), mergeState: "open", mergedSha: null, mergedAt: null };
  state.runs.push(run);
  state.tasks = [{ id: "task-1", runId: run.id, sessionId: "modelroomabc", roomName: "Model room", chatTitle: run.title, createdBy: "alice", creatorName: "Alice",
    assigneeId: "bob", assigneeName: "Bob Stone", assigneeHandle: "bob", body: "Add tests for the login fix", status: "open", createdAt: new Date().toISOString() }];
  // A teammate's ordinary chat in the same repository, to tell whose chat is whose.
  state.runs.push({ ...run, id: "44444444-4444-4444-8444-444444444444", startedBy: "bob", startedByName: "Bob Stone", driverUserId: "bob", driverName: "Bob Stone",
    title: "Bob's API cleanup", addedLines: null, removedLines: null, resultSha: null, isolation: "shared", forkSha: null, headSha: null, mergeState: null });
  state.branches = { [run.id]: { runId: run.id, mergeState: "open", chatHead: sha("c"), roomHead: sha("b"), base: sha("a"), ahead: 2, behind: 1,
    mergedSha: null, files: [{ path: "src/login.ts", status: "M", added: 3, removed: 1 }], conflictMarkers: [], running: false, driverUserId: "alice", controlVersion: 0 } };
  state.diffs = { "src/login.ts": "diff --git a/src/login.ts b/src/login.ts\nindex 1..2 100644\n--- a/src/login.ts\n+++ b/src/login.ts\n@@ -1,2 +1,4 @@\n const attempts = 3;\n-legacyLogin();\n+fixedLogin();\n+audit();\n+done();\n" };
  // First the merge meets a conflict; then bringing in the room's changes commits markers to the chat.
  state.branchOutcomes = [{ ok: false, reason: "conflict", files: ["src/login.ts"] }, { ok: true, sha: sha("e"), changed: true, conflicts: ["src/login.ts"] }];
}

let socket;
try {
  if (server) await eventually(async () => { if (server.exitCode !== null) throw Error(serverOutput); try { return (await fetch(base + "/s/modelroomabc")).ok; } catch { return false; } }, "development server");
  let targets;
  await eventually(async () => { try { targets = await (await fetch("http://127.0.0.1:9338/json")).json(); return targets.length; } catch { return false; } }, "browser");
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  await once(socket, "open");
  let sequence = 0; const pending = new Map(); const errors = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    const operation = pending.get(message.id);
    if (operation) { pending.delete(message.id); clearTimeout(operation.timer); if (message.error) operation.reject(message.error); else operation.resolve(message.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 15000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const button = async (text, scope = "document") => {
    const find = `Array.from(${scope}.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled&&b.checkVisibility())`;
    await eventually(() => evaluate(`!!${find}`), `button: ${text}`);
    await evaluate(`${find}.click()`);
  };
  const posts = () => evaluate(`window.__model.requests.filter(r=>r.path.endsWith("/branch")&&r.method==="POST").map(r=>JSON.parse(r.body))`);

  await send("Page.enable"); await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(${installFixtures.toString()})();(${seedParallelChat.toString()})();` });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: base + "/s/modelroomabc" });
  await eventually(() => evaluate("!!document.body && !!window.__model"), "workspace document");

  // The sidebar shows the chat's branch state.
  const row = `Array.from(document.querySelectorAll('aside[aria-label="Repositories and chats"] button')).find(b=>b.textContent.includes("Parallel login fix"))`;
  await eventually(() => evaluate(`!!${row}`), "parallel chat in the sidebar");
  assert.equal(await evaluate(`${row}.querySelector('span[title^="Parallel chat"]')?.textContent`), "review", "a parallel chat with changes is ready to review");
  // Each chat starts with the face of whoever started it.
  const bobRow = row.replace("Parallel login fix", "Bob's API cleanup");
  await eventually(() => evaluate(`!!${bobRow}`), "teammate's chat in the sidebar");
  assert.match(await evaluate(`${row}.title`), / · Started by you · /);
  assert.match(await evaluate(`${bobRow}.title`), / · Started by Bob Stone · /);
  assert.equal(await evaluate(`${row}.querySelector('.rounded-full')?.textContent`), "AL", "your chat shows your initials");
  assert.equal(await evaluate(`${bobRow}.querySelector('.rounded-full')?.textContent`), "BS", "a teammate's chat shows theirs");
  await writeFile(join(tmpdir(), "multiplayer-chat-owners.png"), Buffer.from((await send("Page.captureScreenshot", { clip: { x: 0, y: 0, width: 420, height: 500, scale: 2 } })).data, "base64"));

  // The chat's nav: its views, the rarer ones under More, then its actions.
  await evaluate(`${row}.click()`);
  const nav = `document.querySelector('nav[aria-label="Chat"]')`;
  const navLabels = () => evaluate(`Array.from(${nav}?.querySelectorAll('button') ?? []).map(b=>b.textContent.trim()).filter(Boolean)`);
  await eventually(async () => (await navLabels()).includes("Changes"), "chat nav");
  await eventually(async () => (await navLabels()).includes("Tasks1"), "count of tasks still to do");
  assert.deepEqual(await navLabels(), ["Chat", "Briefing", "Activity", "Tasks1", "Changes", "Providers", "More", "Ask first", "Copy", "New chat"]);
  assert.equal(await evaluate(`${nav}.querySelector('[aria-current="true"]')?.textContent.trim()`), "Chat", "the conversation is the current view");
  await writeFile(join(tmpdir(), "multiplayer-chat-nav.png"), Buffer.from((await send("Page.captureScreenshot", { clip: { x: 0, y: 0, width: 1440, height: 260, scale: 1 } })).data, "base64"));
  // On a wide screen every label shows.
  await send("Emulation.setDeviceMetricsOverride", { width: 2200, height: 900, deviceScaleFactor: 1, mobile: false });
  await eventually(() => evaluate(`getComputedStyle(Array.from(${nav}.querySelectorAll('button')).find(b=>b.textContent.trim()==="Providers").lastElementChild).position === "static"`), "labels in a wide panel");
  await writeFile(join(tmpdir(), "multiplayer-chat-nav-wide.png"), Buffer.from((await send("Page.captureScreenshot", { clip: { x: 0, y: 100, width: 2200, height: 140, scale: 1 } })).data, "base64"));
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // The fixture's chat has one unread feedback: More says so before it is opened.
  assert.equal(await evaluate(`${nav}.querySelector('button[aria-haspopup="menu"]').getAttribute('aria-label')`), "More: 1 waiting");
  await evaluate(`${nav}.querySelector('button[aria-haspopup="menu"]').click()`);
  await eventually(() => evaluate(`!!${nav}.querySelector('[role="menu"]')`), "More menu");
  assert.deepEqual(await evaluate(`Array.from(${nav}.querySelectorAll('[role="menuitem"]')).map(b=>b.textContent.trim())`), ["Feedback1", "Teammate review", "Fork this chat"]);
  await writeFile(join(tmpdir(), "multiplayer-chat-nav-more.png"), Buffer.from((await send("Page.captureScreenshot", { clip: { x: 0, y: 0, width: 1440, height: 420, scale: 1 } })).data, "base64"));
  await evaluate(`Array.from(${nav}.querySelectorAll('[role="menuitem"]')).find(b=>b.textContent.includes("Teammate review")).click()`);
  await eventually(() => evaluate(`document.querySelector('dialog[open]')?.getAttribute('aria-label') === "Teammate review"`), "teammate review from More");
  assert.equal(await evaluate(`${nav}.querySelector('[aria-current="true"]')?.getAttribute('aria-label') ?? ${nav}.querySelector('button[aria-haspopup="menu"]').className.includes("bg-vs-accent")`), true, "More shows that one of its views is open");
  await evaluate(`document.querySelector('button[aria-label="Close Teammate review"]').click()`);
  // The chat's tasks are under Tasks, with how many are still to do, not in the conversation.
  assert.equal(await evaluate(`!!document.querySelector('.ai-chat-header ~ * section[aria-label="Chat tasks"], [role="log"] section[aria-label="Chat tasks"]')`), false);
  assert.equal(await evaluate(`${nav}.querySelector('button[aria-label="Tasks, 1 to do"]') !== null`), true);
  await evaluate(`${nav}.querySelector('button[aria-label="Tasks, 1 to do"]').click()`);
  await eventually(() => evaluate(`document.querySelector('dialog[open][aria-label="Chat tasks"]')?.innerText.includes("Add tests for the login fix")`), "tasks dialog");
  await writeFile(join(tmpdir(), "multiplayer-chat-tasks.png"), Buffer.from((await send("Page.captureScreenshot", { clip: { x: 0, y: 0, width: 1440, height: 620, scale: 1 } })).data, "base64"));
  await evaluate(`document.querySelector('button[aria-label="Close Chat tasks"]').click()`);
  // Each view opens from the nav and marks itself current while open.
  for (const [label, dialogTitle] of [["Activity", "Synchronized workspace history"], ["Briefing", "Conversation briefing"]]) {
    await eventually(() => evaluate(`!document.querySelector('dialog[open]')`), "previous dialog closed");
    await button(label, nav);
    await eventually(() => evaluate(`document.querySelector('dialog[open]')?.getAttribute('aria-label') === ${JSON.stringify(dialogTitle)}`), `${label} dialog`);
    assert.equal(await evaluate(`${nav}.querySelector('[aria-current="true"]')?.textContent.trim()`), label);
    await evaluate(`document.querySelector('button[aria-label="Close ${dialogTitle}"]').click()`);
  }
  await eventually(() => evaluate(`${nav}.querySelector('[aria-current="true"]')?.textContent.trim() === "Chat"`), "back to the conversation");
  // A teammate's chat offers Fork instead of New.
  await evaluate(`${bobRow}.click()`);
  await eventually(async () => (await navLabels()).includes("Fork chat"), "fork a teammate's chat");
  // Where you'd type: whose chat it is, and Fork chat in place of the message box.
  const watching = `document.querySelector('section[aria-label="Watching Bob Stone’s chat"]')`;
  await eventually(() => evaluate(`!!${watching}`), "watching card in place of the message box");
  assert.match(await evaluate(`${watching}.innerText`), /You’re watching Bob Stone’s chat[\s\S]*Only Bob can message the AI here/);
  assert.equal(await evaluate(`!!document.querySelector('.ai-composer textarea')`), false, "no message box on someone else's chat");
  assert.ok(await evaluate(`[...${watching}.querySelectorAll('button')].some(b=>b.textContent.trim()==="Fork chat")`));
  await writeFile(join(tmpdir(), "multiplayer-watching.png"), Buffer.from((await send("Page.captureScreenshot", { clip: { x: 260, y: 560, width: 660, height: 400, scale: 1 } })).data, "base64"));
  // Straight back, while the teammate's chat is still loading: it must not pull you back to it.
  await evaluate(`${row}.click()`);
  await eventually(async () => (await navLabels()).includes("Changes"), "back to the parallel chat");

  // While an agent works, All files follows its latest checkpoint as Changes does:
  // a file it adds appears, opens read-only with a note, and is editable once the turn ends.
  const explorerHas = name => evaluate(`[...document.querySelectorAll('aside[aria-label="Repository explorer"] button')].some(b=>b.getAttribute('aria-label')==="File: ${name}")`);
  assert.equal(await explorerHas("live.ts"), false);
  await evaluate(`(() => { const m = window.__model; m.repos[0].added = ["live.ts"]; m.files["live.ts"] = "export const live = true;";
    m.liveFiles = { "live.ts": { runId: "${"3".repeat(8)}-3333-4333-8333-333333333333", title: "Parallel login fix" } };
    m.changes = { changes: [{ path: "live.ts", status: "A", added: 1, removed: 0 }], head: "e".repeat(40), totals: { files: 1, added: 1, removed: 0 },
      live: { runId: "33333333-3333-4333-8333-333333333333", title: "Parallel login fix", capturedAt: Date.now() } };
    m.emit("run.activity", { runId: "33333333-3333-4333-8333-333333333333" }); })()`);
  await eventually(() => explorerHas("live.ts"), "the agent's new file in All files");
  await evaluate(`document.querySelector('aside[aria-label="Repository explorer"] button[aria-label="File: live.ts"]').click()`);
  await eventually(() => evaluate(`document.querySelector('.room-file-document [role="status"]')?.textContent.includes("The AI is changing this file in “Parallel login fix”")`), "live file note");
  assert.equal(await evaluate(`document.querySelector('.room-file-document textarea')?.readOnly`), true, "read-only while the agent changes it");
  await writeFile(join(tmpdir(), "multiplayer-live-file.png"), Buffer.from((await send("Page.captureScreenshot", { clip: { x: 0, y: 100, width: 1440, height: 320, scale: 1 } })).data, "base64"));
  await evaluate(`(() => { const m = window.__model; m.liveFiles = {}; m.changes = { ...m.changes, head: "f".repeat(40), live: null }; m.emit("run.finished", { runId: "33333333-3333-4333-8333-333333333333" }); })()`);
  await eventually(() => evaluate(`document.querySelector('.room-file-document textarea')?.readOnly === false`), "editable once the turn ends");
  await evaluate(`(() => { const m = window.__model; m.repos[0].added = []; m.changes = undefined; })()`);
  await evaluate(`${row}.click()`);

  // Review its changes.
  await button("Changes");
  const dialog = `document.querySelector('dialog[open]')`;
  await eventually(() => evaluate(`${dialog}?.innerText.includes("2 commits ahead of the room · 1 behind")`), "branch summary");
  assert.ok(await evaluate(`${dialog}.innerText.includes("src/login.ts")`));
  await evaluate(`Array.from(${dialog}.querySelectorAll('button')).find(b=>b.textContent.includes("src/login.ts")).click()`);
  await eventually(() => evaluate(`!!${dialog}.querySelector('[aria-label="Changes to src/login.ts"]')`), "file diff");
  const diffRows = await evaluate(`Array.from(${dialog}.querySelectorAll('[aria-label="Changes to src/login.ts"] tr')).map(tr=>Array.from(tr.cells).map(td=>td.textContent))`);
  assert.deepEqual(diffRows.find(cells => cells[3] === "fixedLogin();"), ["", "2", "+", "fixedLogin();"], "added lines carry their new line number");
  assert.deepEqual(diffRows.find(cells => cells[3] === "legacyLogin();"), ["2", "", "−", "legacyLogin();"], "removed lines carry their old line number");

  await writeFile(join(tmpdir(), "multiplayer-parallel-changes.png"), Buffer.from((await send("Page.captureScreenshot")).data, "base64"));

  // A merge that conflicts changes nothing and offers to bring the room's changes in.
  await button("Merge into room", dialog);
  await eventually(() => evaluate(`${dialog}.innerText.includes("The room and this chat changed the same lines in:")`), "merge conflict");
  assert.deepEqual((await posts())[0], { action: "merge", expectedChatHead: "c".repeat(40), expectedRoomHead: "b".repeat(40) }, "merge is pinned to the reviewed heads");

  // Bringing them in with markers hands the agent a resolution prompt, in the composer, unsent.
  await button("Bring in changes and ask the agent", dialog);
  await eventually(() => evaluate(`!document.querySelector('dialog[open]')`), "panel closes");
  assert.deepEqual((await posts())[1], { action: "update", version: 0, expectedChatHead: "c".repeat(40), expectedRoomHead: "b".repeat(40), allowConflicts: true });
  await eventually(() => evaluate(`document.querySelector('.ai-composer textarea')?.value.includes("conflict markers")`), "resolution prompt in the composer");
  assert.match(await evaluate(`document.querySelector('.ai-composer textarea').value`), /- src\/login\.ts/);
  assert.equal(await evaluate('window.__model.requests.filter(r=>r.path==="/api/ai/run").length'), 0, "the prompt is not sent automatically");

  // The terminal opens on the member's computer, in the chat's worktree.
  const terminalHeader = `document.querySelector('button[aria-label="New terminal"]')?.closest('header')`;
  // An idle terminal starts collapsed; it opens when asked for.
  assert.equal(await evaluate(`!!${terminalHeader}`), false, "the terminal starts collapsed");
  await evaluate(`document.querySelector('button[title="Open a terminal (Ctrl+\`)"]').click()`);
  await eventually(() => evaluate(`!!${terminalHeader}`), "terminal panel");
  await eventually(() => evaluate(`document.body.innerText.includes("Terminal disabled in browser fixture")`), "terminal without a computer explains why");
  await evaluate(`window.__model.terminal={enabled:true,location:"computer",device:"Alice’s Mac",cwd:"",shell:"",platform:""}`);
  await button("Check again");
  await eventually(() => evaluate(`${terminalHeader}.innerText.includes("Your computer · Alice’s Mac")`), "terminal names the member's computer");
  await evaluate(`document.querySelector('button[aria-label="New terminal"]').click()`);
  await eventually(() => evaluate(`window.__model.sources.some(source=>source.url.startsWith("/api/terminal/pty")&&source.url.includes("runId=33333333-3333-4333-8333-333333333333"))`), "terminal opened in the chat");
  const terminalUrl = new URL(await evaluate(`window.__model.sources.filter(source=>source.url.startsWith("/api/terminal/pty")).at(-1).url`), base);
  assert.equal(terminalUrl.searchParams.get("sessionId"), "modelroomabc");
  assert.equal(terminalUrl.searchParams.get("repoId"), "frontendabcd");

  // A new chat can be opened in parallel; the request asks for its own branch.
  await evaluate(`document.querySelector('button[aria-label="New chat in frontend"]').click()`);
  const toggle = `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes("Parallel")&&b.hasAttribute("aria-pressed"))`;
  await eventually(() => evaluate(`!!${toggle}`), "parallel toggle on a new chat");
  assert.equal(await evaluate(`${toggle}.getAttribute("aria-pressed")`), "false", "new chats work on the room branch unless asked");
  await evaluate(`${toggle}.click()`);
  await eventually(() => evaluate(`${toggle}.getAttribute("aria-pressed")==="true"`), "parallel toggle on");
  await evaluate(`(()=>{const el=document.querySelector('.ai-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,"Add rate limiting to login");el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const sendButton = `document.querySelector('.ai-composer button[aria-label="Send message"]')`;
  await eventually(() => evaluate(`!!${sendButton} && !${sendButton}.disabled`), "send enabled");
  await evaluate(`${sendButton}.click()`);
  await eventually(() => evaluate('window.__model.requests.some(r=>r.path==="/api/ai/run")'), "run request");
  const runRequest = await evaluate('JSON.parse(window.__model.requests.find(r=>r.path==="/api/ai/run").body)');
  assert.equal(runRequest.isolation, "isolated");
  assert.equal(runRequest.repoId, "frontendabcd");
  assert.equal(runRequest.runId, undefined, "a parallel chat is a new chat");

  // Several chats at once. A starts but its computer is slow; New chat opens a
  // usable composer straight away, B is sent and starts, and A's late start
  // never pulls the view away from B. Each keeps its own output.
  const chatA = "aaaaaaaa-0000-4000-8000-00000000000a", chatB = "bbbbbbbb-0000-4000-8000-00000000000b";
  await evaluate(`(()=>{const s=window.__model,run=(id,title)=>({...s.runs[0],id,title,status:"running",isolation:"shared",mergeState:null,addedLines:null,removedLines:null,headSha:null,forkSha:null,createdAt:Date.now(),startedAt:Date.now(),endedAt:null});
    s.release={};
    s.messages={${JSON.stringify(chatA)}:[{role:"user",body:"Task A"},{role:"assistant",body:"Alpha output. Alpha done."}],${JSON.stringify(chatB)}:[{role:"user",body:"Task B"},{role:"assistant",body:"Bravo output."}]};
    s.runScripts=[
      [{until:"startA"},{addRun:run(${JSON.stringify(chatA)},"Task A")},{t:"start",agent:"codex",cwd:"/w",runId:${JSON.stringify(chatA)}},{t:"out",d:"Alpha output. "},{until:"finishA"},{t:"out",d:"Alpha done."},{t:"exit",code:0,ms:1200,headSha:null,committed:false},{close:true}],
      [{addRun:run(${JSON.stringify(chatB)},"Task B")},{t:"start",agent:"codex",cwd:"/w",runId:${JSON.stringify(chatB)}},{t:"out",d:"Bravo output."},{until:"never"}],
    ];})()`);
  const conversation = `(document.querySelector('[data-scroller="conversation"]')?.innerText ?? "")`;
  const typeAndSend = async text => {
    await eventually(() => evaluate(`!!document.querySelector('.ai-composer textarea')`), "message box");
    await evaluate(`(()=>{const el=document.querySelector('.ai-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(text)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await eventually(() => evaluate(`!!${sendButton} && !${sendButton}.disabled`), "send enabled");
    await evaluate(`${sendButton}.click()`);
  };
  const runRequests = () => evaluate('window.__model.requests.filter(r=>r.path==="/api/ai/run").length');
  const sent = await runRequests();
  await evaluate(`document.querySelector('button[aria-label="New chat in frontend"]').click()`);
  await eventually(() => evaluate(`${conversation}.trim()==="" || !${conversation}.includes("Add rate limiting")`), "a fresh chat after a failed send");
  await typeAndSend("Task A");
  await eventually(async () => await runRequests() === sent + 1, "A is sent");
  await eventually(() => evaluate(`document.body.innerText.includes("is working")`), "A shows as working");
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==="Detach")`), false, "no Detach while a chat works");

  await evaluate(`document.querySelector('button[aria-label="New chat in frontend"]').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.ai-composer textarea') && !${conversation}.includes("Task A")`), "New chat opens a usable message box while A starts");
  await typeAndSend("Task B");
  await eventually(() => evaluate(`${conversation}.includes("Bravo output.")`), "B streams");
  await eventually(() => evaluate(`new URLSearchParams(location.search).get("run")===${JSON.stringify(chatB)}`), "B is in the address");

  await evaluate("window.__model.release.startA = true");
  await eventually(() => evaluate(`window.__model.requests.some(r=>r.path.endsWith(${JSON.stringify("/runs/" + chatA)}))`), "A starts late");
  await delay(400);
  assert.equal(await evaluate(`new URLSearchParams(location.search).get("run")`), chatB, "A's late start does not take the view from B");
  assert.equal(await evaluate(`${conversation}.includes("Alpha")`), false, "A's output stays out of B");

  const sidebarRow = title => `Array.from(document.querySelectorAll('aside[aria-label="Repositories and chats"] button')).find(b=>b.textContent.includes(${JSON.stringify(title)}))`;
  await eventually(() => evaluate(`!!${sidebarRow("Task A")}`), "A in the sidebar");
  await evaluate(`${sidebarRow("Task A")}.click()`);
  await eventually(() => evaluate(`${conversation}.includes("Alpha output.") && !${conversation}.includes("Bravo")`), "A shows its own live output");
  await evaluate(`${sidebarRow("Task B")}.click()`);
  await eventually(() => evaluate(`${conversation}.includes("Bravo output.") && !${conversation}.includes("Alpha")`), "B still has its output");

  // Stop is for the chat on screen only; A keeps going and finishes in the background.
  await eventually(() => evaluate(`!!document.querySelector('button[aria-label="Stop"]')?.checkVisibility()`), "Stop on B");
  await evaluate(`document.querySelector('button[aria-label="Stop"]').click()`);
  await eventually(() => evaluate("window.__model.stops >= 1"), "B is asked to stop");
  assert.equal(await evaluate(`window.__model.requests.filter(r=>r.path.endsWith("/stop")).map(r=>r.path).join()`).then(paths => paths.includes(chatB) && !paths.includes(chatA)), true, "only B is stopped");
  await evaluate(`(()=>{const s=window.__model;s.runs.find(r=>r.id===${JSON.stringify(chatA)}).status="completed";s.release.finishA=true;})()`);
  await eventually(() => evaluate(`!${sidebarRow("Task A")}.textContent.includes("AI working")`), "A's finish shows in the sidebar");
  assert.equal(await evaluate(`new URLSearchParams(location.search).get("run")`), chatB, "finishing A does not switch chats");
  await evaluate(`${sidebarRow("Task A")}.click()`);
  await eventually(() => evaluate(`${conversation}.includes("Alpha done.")`), "A shows its finished reply");
  await evaluate(`window.__model.runs.find(r=>r.id===${JSON.stringify(chatB)}).status="completed"`);

  // An unsent message waits in its new chat while another chat is open.
  await evaluate(`document.querySelector('button[aria-label="New chat in frontend"]').click()`);
  await eventually(() => evaluate(`!!document.querySelector('.ai-composer textarea') && !${conversation}.includes("Alpha")`), "another new chat");
  await evaluate(`(()=>{const el=document.querySelector('.ai-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,"Half-written idea");el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(`${sidebarRow("Task A")}.click()`);
  await eventually(() => evaluate(`${conversation}.includes("Alpha done.")`), "back in A");
  await evaluate(`document.querySelector('button[aria-label="New chat in frontend"]').click()`);
  await eventually(() => evaluate(`document.querySelector('.ai-composer textarea')?.value==="Half-written idea"`), "the unsent message is still there");

  // A dropped connection is not the agent finishing: the chat keeps showing it
  // working, and reloads what was saved.
  const chatC = "cccccccc-0000-4000-8000-00000000000c";
  await evaluate(`(()=>{const s=window.__model;s.messages[${JSON.stringify(chatC)}]=[{role:"user",body:"Half-written idea"},{role:"assistant",body:"Charlie saved so far."}];
    s.runScripts=[[{addRun:{...s.runs[0],id:${JSON.stringify(chatC)},title:"Task C",status:"running",isolation:"shared",mergeState:null,addedLines:null,removedLines:null,headSha:null,forkSha:null,startedAt:Date.now(),endedAt:null}},
      {t:"start",agent:"codex",cwd:"/w",runId:${JSON.stringify(chatC)}},{t:"out",d:"Charlie live. "},{wait:300},{close:true}]];})()`);
  await eventually(() => evaluate(`!!${sendButton} && !${sendButton}.disabled`), "send enabled");
  await evaluate(`${sendButton}.click()`);
  await eventually(() => evaluate(`${conversation}.includes("Charlie saved so far.")`), "a lost stream reloads the saved conversation");
  assert.equal(await evaluate(`document.body.innerText.includes("is working")`), true, "and the chat still shows the agent working");
  await evaluate(`window.__model.runs.find(r=>r.id===${JSON.stringify(chatC)}).status="completed"`);

  // The terminal comes back as it was left: open after a reload, collapsed once closed.
  const reload = async () => {
    await evaluate("window.__beforeReload = true");
    await send("Page.reload");
    await eventually(() => evaluate("!window.__beforeReload && !!window.__model && document.body.innerText.includes('Parallel login fix')"), "room reloads");
  };
  await reload();
  await eventually(() => evaluate(`!!${terminalHeader}`), "an open terminal stays open after a reload");
  await evaluate(`document.querySelector('button[aria-label="Close terminal"]').click()`);
  await reload();
  await delay(500);
  assert.equal(await evaluate(`!!${terminalHeader}`), false, "a closed terminal stays closed after a reload");

  assert.deepEqual(errors, []);
  assert.deepEqual(await evaluate("window.__model.unknown"), []);
  console.log("PASS: parallel toggle, several chats at once (no Detach, late starts keep the view, separate output, Stop per chat, drafts kept, lost streams reload), sidebar branch state, change review with line-numbered diffs, conflict-safe merge and agent resolution prompt.");
} catch (error) {
  console.error(serverOutput.slice(-3000));
  throw error;
} finally {
  socket?.close();
  chrome.kill();
  server?.kill();
}
