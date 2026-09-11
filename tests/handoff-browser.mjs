import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--port", String(port)], {
    env: { ...process.env, DATABASE_URL: databaseUrl, REDIS_URL: redisUrl ?? "redis://localhost:6380",
      MULTIPLAYER_AI_DATA: directory, MNEMOSYNE_URL: "", LOCAL_RUNNERS: "1", AGENT_WORKER: "0",
      NEXT_TEST_DIST_DIR: ".next-handoff-test", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.stdout.on("data", chunk => { output += chunk; });
  next.stderr.on("data", chunk => { output += chunk; });
  let chrome;
  let socket;
  const pending = new Map();
  let sequence = 0;
  const runtimeErrors = [];
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
    const endpoint = `/api/sessions/${roomId}/runs/${chat.id}/handoff`;
    assert.equal((await request(tokens[0], endpoint, "POST", { action: "wat", version: 0 })).status, 400);
    const created = await request(tokens[0], `/api/sessions/${roomId}/repos`, "POST", { name: "Imported storefront" });
    assert.equal(created.status, 200);
    const imported = (await created.json()).repo;
    const seedUrl = `/api/sessions/${roomId}/repos/${imported.id}/seed`;
    const seedBody = { files: [{ path: "src/checkout.ts", data: Buffer.from("export const checkout = 'ready';\n").toString("base64") }], done: true };
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
      if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
    async function tab(token) {
      const { browserContextId } = await send("Target.createBrowserContext");
      const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const command = (method, params) => send(method, params, sessionId);
      await command("Page.enable"); await command("Runtime.enable");
      await command("Network.setCookie", { name: "ma_auth", value: token, url: server, httpOnly: true, sameSite: "Lax" });
      await command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
      const evaluate = async expression => {
        const result = await command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      const click = text => evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === ${JSON.stringify(text)})?.click()`);
      await command("Page.navigate", { url: `${server}/s/${roomId}` });
      try {
        await eventually(() => evaluate("!!document.querySelector('select[aria-label=\"Active repository\"]')"), "room workspace");
      } catch (cause) {
        console.error(await evaluate("document.body.innerText.slice(0, 5000)"), runtimeErrors);
        throw cause;
      }
      return { command, evaluate, click };
    }
    const sender = await tab(tokens[0]);
    const recipient = await tab(tokens[1]);
    for (const view of [sender]) {
      await view.click("Chats & team");
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
    await recipient.evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('checkout.ts'))?.click()");
    await eventually(() => recipient.evaluate("document.body.textContent.includes('ready') || Array.from(document.querySelectorAll('textarea')).some(input => input.value.includes('ready'))"), "imported file editor");
    for (const [width, height, name] of [[1440, 960, "desktop"], [390, 844, "mobile"]]) {
      await recipient.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await delay(300);
      assert.equal(await recipient.evaluate("document.documentElement.scrollWidth <= innerWidth"), true, `No ${name} overflow`);
      const screenshot = await recipient.command("Page.captureScreenshot", { format: "png" });
      await writeFile(join("/tmp", `handoff-room-${name}.png`), Buffer.from(screenshot.data, "base64"));
    }
    console.log("  ok imported repository selection, file opening, desktop and mobile layout");
    await recipient.evaluate(`(() => {
      const input = document.querySelectorAll('input[type="file"]')[1];
      const file = new File(["export const uploaded = true;\\n"], "uploaded.ts", { type: "text/plain" });
      Object.defineProperty(file, 'webkitRelativePath', { value: 'Browser upload/uploaded.ts' });
      const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await eventually(() => recipient.evaluate("document.querySelector('select[aria-label=\"Active repository\"]').selectedOptions[0].textContent === 'Browser upload' && document.body.textContent.includes('uploaded.ts')"), "automatic file selection after folder upload");
    console.log("  ok browser folder-upload flow automatically selects its imported repository and reveals its files");

    const deviceToken = randomBytes(32).toString("base64url");
    await sql(`INSERT INTO runner_devices(user_id,name,token_hash,version,agent_ids,last_seen_at) VALUES ($1,'Simulated Bob runner',$2,'2',ARRAY['codex'],now())`, [bob, createHash("sha256").update(deviceToken).digest()]);
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
      const runnerGit = new RunnerGit(server, deviceToken, join(directory, "simulated-runner"));
      const work = await runnerGit.ensureWork(job.repoId ?? job.sessionId, job.baseSha, job.turnId);
      await writeFile(join(work, `step-${index}.txt`), `Deterministic runner output ${index}\n`);
      const resultSha = await runnerGit.commitAndPush(job.repoId ?? job.sessionId, "Simulated turn", job.author, job.turnId, job.baseSha);
      const report = { code: 0, resultSha, output: `Finished step ${index}`, errOutput: "", ms: 5 };
      assert.equal((await runnerRequest(`/api/runner/runs/${job.turnId}/complete`, report)).status, 200);
      assert.equal((await runnerRequest(`/api/runner/runs/${job.turnId}/complete`, report)).status, 200);
      assert.match(await streamText, /"t":"exit"/);
    }
    assert.deepEqual(runtimeErrors, []);
    console.log("  ok real run/claim/smart-HTTP/completion APIs: two successive turns on recipient device, duplicate completion, old-driver refusal");
  } finally {
    await writeFile("/tmp/handoff-browser-server.log", output);
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
