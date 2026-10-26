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
  state.parallelChats = true;
  state.repos.push({ id: "frontendabcd", sessionId: "modelroomabc", rootName: "frontend", projectRepositoryId: "11111111-1111-4111-8111-111111111111",
    headSha: sha("b"), baseSha: sha("a"), seededAt: 1, createdAt: 1, createdBy: "alice" });
  const run = { id: "33333333-3333-4333-8333-333333333333", sessionId: "modelroomabc", repoId: "frontendabcd", startedBy: "alice", startedByName: "Alice",
    driverUserId: "alice", driverName: "Alice", controlVersion: 0, restoreSnapshotId: null, agentId: "codex", title: "Parallel login fix",
    status: "completed", baseSha: sha("a"), resultSha: sha("c"), addedLines: 3, removedLines: 1, exitCode: 0, error: null,
    createdAt: Date.now() - 60000, startedAt: Date.now() - 60000, endedAt: Date.now() - 30000, archivedAt: null,
    isolation: "isolated", forkSha: sha("a"), headSha: sha("c"), mergeState: "open", mergedSha: null, mergedAt: null };
  state.runs.push(run);
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

  // Review its changes.
  await evaluate(`${row}.click()`);
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

  assert.deepEqual(errors, []);
  assert.deepEqual(await evaluate("window.__model.unknown"), []);
  console.log("PASS: parallel toggle, sidebar branch state, change review with line-numbered diffs, conflict-safe merge and agent resolution prompt.");
} catch (error) {
  console.error(serverOutput.slice(-3000));
  throw error;
} finally {
  socket?.close();
  chrome.kill();
  server?.kill();
}
