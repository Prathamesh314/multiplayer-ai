const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { workspaceUrl, sameOrigin, externalUrl, waitForServer, runnerEnvironment } = require("../desktop/policy");

test("workspace origins reject insecure remote servers and ambiguous addresses", () => {
  assert.equal(workspaceUrl("https://team.example/"), "https://team.example");
  assert.equal(workspaceUrl("http://127.0.0.1:3000", true), "http://127.0.0.1:3000");
  for (const value of ["http://team.example", "http://localhost:3000", "file:///tmp/app", "javascript:alert(1)", "https://user:secret@team.example", "https://team.example/path", "https://team.example/?token=x", "https://team.example/#x"]) assert.throws(() => workspaceUrl(value));
});

test("origin comparison is exact, not a string prefix", () => {
  const origin = "https://team.example";
  assert.equal(sameOrigin(origin + "/rooms/one", origin), true);
  for (const value of [origin + ".evil.test", origin + "@evil.test", "http://team.example", "https://team.example:444", "file:///tmp/a", "not a URL", "https://user@team.example"]) assert.equal(sameOrigin(value, origin), false);
});

test("external links cannot execute arbitrary OS protocols", () => {
  for (const url of ["https://example.com", "http://example.com", "mailto:team@example.com"]) assert.equal(externalUrl(url), true);
  for (const url of ["file:///tmp/a", "javascript:alert(1)", "data:text/html,hi", "ms-settings:foo", "vscode://file/foo", "https://user:pass@example.com"]) assert.equal(externalUrl(url), false);
});

test("runner gets CLI credentials but not application secrets or Node injection", () => {
  const env = runnerEnvironment({ HOME: "/home/test", PATH: "/usr/bin", OPENAI_API_KEY: "cli", DATABASE_URL: "secret", REDIS_URL: "secret", NODE_OPTIONS: "--require=evil", ELECTRON_RUN_AS_NODE: "1", RUNNER_CONFIG: "evil" }, "/safe/config");
  assert.equal(env.OPENAI_API_KEY, "cli");
  assert.equal(env.RUNNER_CONFIG, "/safe/config");
  for (const key of ["DATABASE_URL", "REDIS_URL", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) assert.equal(env[key], undefined);
});

test("readiness rejects 500 responses, times out hung responses, and supports cancellation", async () => {
  let mode = "error";
  const server = http.createServer((_request, response) => {
    if (mode === "hang") return;
    response.writeHead(mode === "error" ? 500 : 200).end("ready");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  try {
    await assert.rejects(waitForServer(url, { timeoutMs: 100, intervalMs: 10 }), /did not respond/);
    mode = "ok";
    await waitForServer(url, { timeoutMs: 1000 });
    mode = "hang";
    await assert.rejects(waitForServer(url, { timeoutMs: 100, intervalMs: 10 }), /did not respond/);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(waitForServer(url, { signal: controller.signal }), /abort/i);
    await assert.rejects(waitForServer("file:///tmp/app"), /protocol/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

function harness() {
  const handlers = new Map();
  const writes = new Map();
  const children = [];
  const app = Object.assign(new EventEmitter(), { setName() {}, getPath: () => "/profile", getVersion: () => "0.1.0", isPackaged: true, requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), quit() {} });
  const electron = { app, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: { showMessageBox: async () => ({ response: 0 }) }, shell: { openExternal: () => { throw new Error("Must not open an external protocol"); } }, utilityProcess: { fork: (...args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), args, postMessage: value => { child.lastMessage = value; } });
    children.push(child);
    return child;
  } } };
  const mockFs = { ...fs, readFileSync: file => {
    if (file.endsWith("release.json")) return JSON.stringify({ workspaceUrl: "https://team.example", updateUrl: "" });
    if (writes.has(file)) return writes.get(file).value;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }, mkdirSync() {}, writeFileSync: (file, value, options) => writes.set(file, { value, options }), renameSync: (from, to) => { writes.set(to, writes.get(from)); writes.delete(from); } };
  const requests = [];
  const context = vm.createContext({ require: name => name === "electron" ? electron : name === "node:fs" ? mockFs : name === "./policy" ? require("../desktop/policy") : require(name), __dirname: path.resolve("desktop"), process: { env: {}, platform: process.platform, argv: [], resourcesPath: "/resources" }, URL, AbortController, AbortSignal, console, setInterval, clearInterval, fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ token: "private-device-token" }) }; } });
  const source = fs.readFileSync("desktop/main.js", "utf8");
  vm.runInContext(source + "\nglobalThis.api = { security, registerIpc, requireSetup, toggleRunner, setWindows: (workspace, setup) => { mainWindow = workspace; setupWindow = setup; }, setupUrl };", context);
  context.api.registerIpc();
  return { ...context.api, handlers, electron, writes, requests, children };
}

function mockWindow(url) {
  const session = new EventEmitter();
  session.setPermissionRequestHandler = callback => { session.requestPermission = callback; };
  session.setPermissionCheckHandler = callback => { session.checkPermission = callback; };
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url }, session, setWindowOpenHandler(callback) { this.openWindow = callback; } });
  return { webContents: contents };
}

test("main process denies popup protocols, off-origin navigation, webviews and permissions", () => {
  const instance = harness();
  const window = mockWindow("https://team.example");
  instance.security(window);
  assert.equal(window.webContents.openWindow({ url: "file:///tmp/a" }).action, "deny");
  for (const eventName of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    let blocked = false;
    window.webContents.emit(eventName, { url: "https://team.example.evil.test", preventDefault() { blocked = true; } }, "https://team.example.evil.test");
    assert.equal(blocked, true);
  }
  assert.equal(window.webContents.session.checkPermission(), false);
  window.webContents.session.requestPermission(null, "media", allowed => assert.equal(allowed, false));
  let blocked = false;
  window.webContents.emit("will-attach-webview", { preventDefault() { blocked = true; } });
  assert.equal(blocked, true);
});

test("privileged IPC checks window identity, main frame, and exact origin", async () => {
  const instance = harness();
  const workspace = mockWindow("https://team.example/rooms/one");
  const setup = mockWindow(instance.setupUrl);
  instance.setWindows(workspace, setup);
  const pair = instance.handlers.get("desktop:pair");
  await assert.rejects(pair({ sender: setup.webContents, senderFrame: setup.webContents.mainFrame }, "RN-ABCD-1234"), /Not allowed/);
  await assert.rejects(pair({ sender: workspace.webContents, senderFrame: { url: "https://team.example" } }, "RN-ABCD-1234"), /Not allowed/);
  const sender = { sender: workspace.webContents, senderFrame: workspace.webContents.mainFrame };
  assert.equal((await pair(sender, "not-a-code")).ok, false);
  assert.equal((await pair(sender, "RN-ABCD-1234")).error, "Pairing cancelled.");
  workspace.webContents.mainFrame.url = "https://team.example.evil.test";
  await assert.rejects(pair(sender, "RN-ABCD-1234"), /Not allowed/);
  assert.throws(() => instance.requireSetup(sender), /Not allowed/);
  instance.requireSetup({ sender: setup.webContents, senderFrame: setup.webContents.mainFrame });
});

test("desktop staging uses an allowlist and release packaging requires signing", () => {
  const prepare = fs.readFileSync("desktop/prepare.mjs", "utf8");
  const builder = fs.readFileSync("desktop/builder.cjs", "utf8");
  const packager = fs.readFileSync("desktop/package.mjs", "utf8");
  assert.match(prepare, /Release builds require DESKTOP_WORKSPACE_URL and DESKTOP_UPDATE_URL/);
  assert.match(builder, /forceCodeSigning: release/);
  assert.match(builder, /runAsNode: false/);
  assert.match(builder, /onlyLoadAppFromAsar: true/);
  assert.match(builder, /verifyUpdateCodeSignature: true/);
  assert.match(packager, /Apple notarization credentials are required/);
  assert.doesNotMatch(builder, /"\*\*\/\*"/);
});

test("desktop build targets record the target architecture when cross compiling", () => {
  const { buildTarget, packagedExecutable } = require("../desktop/targets.cjs");
  assert.equal(buildTarget(["--win"], "darwin", "arm64").arch, "x64");
  assert.deepEqual(buildTarget(["--linux", "--arm64", "--setup"], "darwin", "arm64").builderArgs, ["--linux", "--arm64"]);
  assert.equal(buildTarget([], "darwin", "arm64").arch, "arm64");
  assert.match(packagedExecutable("output", "linux", "x64"), /linux-unpacked[/\\]multiplayer-ai$/);
  assert.match(packagedExecutable("output", "win32", "arm64"), /win-arm64-unpacked[/\\]Multiplayer AI\.exe$/);
  assert.match(packagedExecutable("output", "darwin", "x64"), /mac[/\\]Multiplayer AI\.app[/\\]Contents[/\\]MacOS[/\\]Multiplayer AI$/);
});

test("desktop build arguments cannot bypass preview publishing or release requirements", () => {
  const { buildTarget } = require("../desktop/targets.cjs");
  for (const args of [["--publish", "always"], ["--config", "other.json"], ["--mac", "--win"], ["--x64", "--arm64"], ["--release", "--setup"]]) {
    assert.throws(() => buildTarget(args, "darwin", "arm64"));
  }
  assert.throws(() => buildTarget(["--mac"], "linux", "x64"), /on a Mac/);
  assert.throws(() => buildTarget(["--win", "--release"], "darwin", "arm64"), /target platform/);
});

test("approved native pairing stores a private token, starts the bundled runner, and drains on pause", async () => {
  const instance = harness();
  instance.electron.dialog.showMessageBox = async () => ({ response: 1 });
  const workspace = mockWindow("https://team.example/rooms/one");
  const setup = mockWindow(instance.setupUrl);
  instance.setWindows(workspace, setup);
  const result = await instance.handlers.get("desktop:pair")({ sender: workspace.webContents, senderFrame: workspace.webContents.mainFrame }, "RN-ABCD-1234");
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes("private-device-token"), false);
  assert.equal(instance.requests[0].url, "https://team.example/api/runner/pair");
  assert.equal(instance.requests[0].options.redirect, "error");
  const config = [...instance.writes.entries()].find(([file]) => file.endsWith("runner.json"))[1];
  assert.equal(config.options.mode, 0o600);
  assert.equal(JSON.parse(config.value).token, "private-device-token");
  assert.equal(instance.children.length, 1);
  assert.match(instance.children[0].args[0], /app\.asar\.unpacked[/\\]runner\.cjs$/);
  instance.toggleRunner();
  assert.equal(instance.children[0].lastMessage.type, "shutdown");
  instance.children[0].emit("exit", 0);
  const state = await instance.handlers.get("desktop:status")({ sender: setup.webContents, senderFrame: setup.webContents.mainFrame });
  assert.equal(state.runner, "paused");
  assert.equal(state.enabled, false);
});
