import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";

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
const server = createServer((request, response) => {
  if (request.url === "/api/runner/claim") {
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
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const args = packaged ? [] : [".desktop-build/app"];
  child = spawn(executable, [...args, "--user-data-dir=" + directory, "--remote-debugging-port=0"], { env: { ...process.env, APP_URL: "", DESKTOP_RUNNER: "0", DESKTOP_SPAWN_SERVER: "0" }, stdio: ["ignore", "pipe", "pipe"] });
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
