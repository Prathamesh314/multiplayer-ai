import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { build as bundle } from "esbuild";

const require = createRequire(import.meta.url);
const packaged = process.argv.includes("--packaged") || Boolean(process.env.DESKTOP_SMOKE_EXECUTABLE);
const build = packaged && !process.env.DESKTOP_SMOKE_EXECUTABLE ? JSON.parse(await readFile(".desktop-build/output.json", "utf8")) : null;
if (build && (build.platform !== process.platform || build.arch !== process.arch)) throw new Error("Run the packaged smoke test on the build's native platform and architecture.");
const packagedPath = build?.executable || (build && require("../desktop/targets.cjs").packagedExecutable(build.directory, build.platform, build.arch));
const executable = process.env.DESKTOP_SMOKE_EXECUTABLE || (packaged ? packagedPath : require("electron"));
const directory = await mkdtemp(join(tmpdir(), "multiplayer-desktop-smoke-"));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const clients = [];
let child;
let output = "";
let automaticPairs = 0;
const fixtureUser = "a06b6c4d-b8ed-43c1-a092-f7304c6c94e4";
const fixtureDevice = "15dc2939-43e7-450b-9d4e-f7f19a7c02c1";
let signInBundle, desktopApproval, desktopApproved=false, desktopRedemptions=0;
const server = createServer(async (request, response) => {
  const json = body => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (request.url === "/desktop-sign-in.js") {
    response.writeHead(200, {"content-type":"text/javascript"}).end(signInBundle);
  } else if (request.url === "/login") {
    response.writeHead(200, {"content-type":"text/html"}).end('<!doctype html><html><body><div id="root"></div><script src="/desktop-sign-in.js"></script></body></html>');
  } else if (["/api/auth/desktop", "/api/auth/desktop/redeem"].includes(request.url)) {
    let raw="";for await(const chunk of request)raw+=chunk;
    const body=JSON.parse(raw);
    if(request.url==="/api/auth/desktop") {
      desktopApproval={id:"11111111-1111-1111-1111-111111111111",challenge:body.challenge};
      json({id:desktopApproval.id,code:"11111111"});
    } else if(!desktopApproved || desktopRedemptions || body.id!==desktopApproval.id ||
      createHash("sha256").update(body.verifier).digest("base64url")!==desktopApproval.challenge) {
      response.writeHead(400,{"content-type":"application/json"}).end(JSON.stringify({error:"Approve sign-in in your browser first, or start again."}));
    } else {
      desktopRedemptions++;json({ticket:"desktop-fixture-ticket",userId:"user_desktop_fixture"});
    }
  } else if (request.url === "/api/auth/me") {
    json({ user: request.headers.cookie?.includes("__session=fixture-alice") ? { id: fixtureUser } : null });
  } else if (request.url === "/api/runner/pairing") {
    assert.match(request.headers.cookie ?? "", /__session=fixture-alice/);
    json({ code: "RN-ABCD-EFGH" });
  } else if (request.url === "/api/runner/pair") {
    automaticPairs++;
    json({ token: "fixture-private-device-token", device: { id: fixtureDevice, userId: fixtureUser } });
  } else if (request.url === "/api/runner/me") {
    assert.equal(request.headers.authorization, "Bearer fixture-private-device-token");
    json({ device: { id: fixtureDevice, userId: fixtureUser } });
  } else if (request.url === "/api/runner/claim") {
    setTimeout(() => response.writeHead(200, { "content-type": "application/json" }).end('{"job":null}'), 100);
  } else if (request.url === "/api/runner/heartbeat") {
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  } else {
    response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><html><title>Desktop fixture</title><body><h1>Workspace connected</h1></body></html>');
  }
});

async function eventually(task, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error("Electron exited: " + child.exitCode + " / " + child.signalCode + "\n" + output);
    try { const result = await task(); if (result) return result; } catch {}
    await delay(150);
  }
  throw new Error("Timed out: " + label + "\n" + output.slice(-3000));
}

async function client(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await once(socket, "open");
  clients.push(socket);
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.error) entry.reject(new Error(JSON.stringify(data.error)));
    else entry.resolve(data.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return { send, evaluate };
}

try {
  if(!packaged) {
    const result=await bundle({entryPoints:["tests/fixtures/desktop-sign-in.jsx"],bundle:true,write:false,platform:"browser",jsx:"automatic",
      plugins:[{name:"clerk-fixture",setup(build){
        build.onResolve({filter:/^@clerk\/nextjs$/},()=>({path:"clerk",namespace:"fixture"}));
        build.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"export const useClerk=()=>window.clerkFixture;",loader:"js"}));
      }}]});
    signInBundle=result.outputFiles[0].contents;
  }
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const args = packaged ? [] : [".desktop-build/app"];
  child = spawn(executable, [...args, "--user-data-dir=" + directory, "--remote-debugging-port=0"], { env: { ...process.env, APP_URL: "", DESKTOP_RUNNER: "1", DESKTOP_SPAWN_SERVER: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.on("error", error => { output += error.stack; });
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const port = await eventually(async () => (await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0], "Electron debugging endpoint");
  const targets = async () => (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
  const setupTarget = await eventually(async () => (await targets()).find(target => target.url.endsWith("setup.html")), "setup window");
  const setup = await client(setupTarget);
  await eventually(() => setup.evaluate("document.body.innerText.includes('Workspace address')"), "setup page rendered");
  assert.equal(await setup.evaluate("typeof require"), "undefined");
  assert.equal(await setup.evaluate("typeof window.desktopSetup.status"), "function");
  await eventually(() => setup.evaluate("document.getElementById('workspaces-path').textContent.length > 0"), "local worktree folder displayed");
  assert.equal(await setup.evaluate("document.getElementById('workspaces-path').textContent"), (await setup.evaluate("window.desktopSetup.status()")).workspacesDir);
  assert.equal(await setup.evaluate("typeof window.desktopSetup.chooseWorkspaces"), "function");
  await setup.evaluate("window.desktopSetup.connect('http://untrusted.example')");
  assert.match((await setup.evaluate("window.desktopSetup.status()")).message, /HTTPS/);
  console.log("ok setup, sandbox, and insecure-server rejection");
  if (packaged) {
    await setup.evaluate("window.desktopSetup.connect('http://localhost:3000')");
    assert.match((await setup.evaluate("window.desktopSetup.status()")).message, /HTTPS/);
    console.log("ok packaged app rejects development HTTP endpoints");
  } else {
    await setup.evaluate("window.desktopSetup.connect(" + JSON.stringify(origin) + ")");
    const target = await eventually(async () => (await targets()).find(target => target.url.startsWith(origin)), "workspace window");
    const workspace = await client(target);
    assert.equal(await workspace.evaluate("document.querySelector('h1').textContent"), "Workspace connected");
    assert.equal(await workspace.evaluate("typeof require"), "undefined");
    assert.equal(await workspace.evaluate("typeof window.desktopSetup"), "undefined");
    assert.equal(await workspace.evaluate("window.desktop.isDesktop"), true);
    assert.equal((await workspace.evaluate("window.desktop.pairComputer('invalid')")).ok, false);
    await workspace.evaluate("window.open('file:///tmp/forbidden.html'); location.href='http://127.0.0.1.evil.test/'");
    await delay(300);
    assert.equal(await workspace.evaluate("location.origin"), origin);
    assert.equal((await targets()).filter(target => target.type === "page").length, 2);
    console.log("ok workspace preload, privileged bridge separation, popup and navigation blocks");
    assert.equal(automaticPairs, 0, "No device is paired before sign-in");
    await workspace.send("Page.navigate",{url:origin+"/login"});
    const click=label=>workspace.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`);
    await eventually(()=>workspace.evaluate("document.body.innerText.includes('Continue with Google')"),"desktop sign-in form");
    await click("Continue with Google");
    await eventually(()=>workspace.evaluate("!!window.approvalUrl"),"browser approval opened");
    assert.equal(new URL(await workspace.evaluate("window.approvalUrl")).searchParams.get("desktop"),desktopApproval.id);
    await click("Complete sign-in");
    await eventually(()=>workspace.evaluate("document.querySelector('[role=alert]')?.textContent.includes('Approve sign-in')"),"approval is required");
    desktopApproved=true;
    await click("Complete sign-in");
    await eventually(()=>workspace.evaluate("document.querySelector('[role=alert]')?.textContent.includes('could not be activated')"),"actionable activation error");
    assert.equal(desktopRedemptions,1);
    assert.deepEqual(await workspace.evaluate("window.signInCalls"),{tickets:1,activations:1});
    // A same-tick double click cannot spend another approval or activate twice.
    await workspace.evaluate("const complete=Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Complete sign-in');complete.click();complete.click();");
    await eventually(()=>workspace.evaluate("location.pathname==='/auth/complete'"),"retry opens the workspace completion page");
    assert.equal(desktopRedemptions,1,"activation retry must not replay the single-use approval");
    assert.deepEqual(await workspace.evaluate("JSON.parse(sessionStorage.getItem('desktop-sign-in-calls'))"),{tickets:1,activations:2});
    assert.equal(automaticPairs,0,"the fixture cannot authenticate or pair a real account");
    console.log("ok desktop browser approval, ticket exchange, activation failure and successful retry without replay");
    await workspace.send("Network.setCookie", { name: "__session", value: "fixture-alice", url: origin, httpOnly: true });
    await eventually(async () => (await setup.evaluate("window.desktopSetup.status()")).runner === "online", "automatic desktop connection after sign-in");
    assert.equal(automaticPairs, 1);
    const saved = JSON.parse(await readFile(join(directory,"runner.json"),"utf8"));
    assert.equal(saved.userId, fixtureUser);
    assert.equal(saved.deviceId, fixtureDevice);
    assert.equal(saved.token,"fixture-private-device-token");
    assert.equal(await workspace.evaluate("JSON.stringify(window.desktop).includes('fixture-private-device-token')"),false);
    await workspace.send("Network.deleteCookies",{name:"__session",url:origin});
    await eventually(async () => (await setup.evaluate("window.desktopSetup.status()")).runner === "paused", "sign-out drains runner");
    await workspace.send("Network.setCookie",{name:"__session",value:"fixture-alice",url:origin,httpOnly:true});
    await eventually(async () => (await setup.evaluate("window.desktopSetup.status()")).runner === "online", "sign-in reuses saved connection");
    assert.equal(automaticPairs,1);
    await setup.evaluate("window.desktopSetup.toggleRunner()");
    await eventually(async () => (await setup.evaluate("window.desktopSetup.status()")).runner === "paused", "manual pause");
    console.log("ok native automatic pairing, cookie isolation, sign-out, reuse without duplicate devices, and pause");
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await workspace.send("Page.reload");
    await eventually(async () => (await setup.evaluate("window.desktopSetup.status()")).message.includes("could not load"), "offline recovery message");
    const screenshot = await setup.send("Page.captureScreenshot");
    const screenshotPath = join(tmpdir(), "multiplayer-desktop-setup.png");
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    console.log("ok offline recovery; screenshot " + screenshotPath);
  }
  console.log("Desktop smoke checks passed.");
} finally {
  for (const socket of clients) socket.close();
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // Windows helpers can briefly retain SQLite handles after the parent exits.
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

if (!packaged) {
  const runnerDirectory = await mkdtemp(join(tmpdir(), "multiplayer-runner-smoke-"));
  const backend = createServer((request, response) => response.writeHead(200, { "content-type": "application/json" }).end(request.url.endsWith("claim") ? '{"job":null}' : "{}"));
  await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
  try {
    const config = join(runnerDirectory, "runner.json");
    await writeFile(config, JSON.stringify({ server: "http://127.0.0.1:" + backend.address().port, token: "fixture-token", name: "Smoke", dataDir: runnerDirectory }), { mode: 0o600 });
    const runner = spawn(executable, ["tests/fixtures/desktop-runner.cjs"], { env: { ...process.env, RUNNER_SMOKE_ENTRY: resolve(".desktop-build/app/runner.cjs"), RUNNER_SMOKE_CONFIG: config }, stdio: ["ignore", "pipe", "pipe"] });
    let runnerOutput = "";
    runner.stdout.on("data", chunk => { runnerOutput += chunk; });
    runner.stderr.on("data", chunk => { runnerOutput += chunk; });
    const timer = setTimeout(() => runner.kill("SIGKILL"), 30000);
    const [code] = await once(runner, "exit");
    clearTimeout(timer);
    assert.equal(code, 0, runnerOutput);
    assert.match(runnerOutput, /Bundled runner drained and stopped/);
    console.log("ok bundled utility-process runner starts and drains without npm or installed agents");
  } finally {
    backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
    await rm(runnerDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
