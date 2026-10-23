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
  const context = vm.createContext({ require: name => name === "electron" ? electron : name === "node:fs" ? mockFs : name === "./policy" ? require("../desktop/policy") : name === "./connection" ? require("../desktop/connection") : require(name), __dirname: path.resolve("desktop"), process: { env: {}, platform: process.platform, argv: [], resourcesPath: "/resources" }, URL, AbortController, AbortSignal, Buffer, console, setInterval, clearInterval, fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ token: "private-device-token" }) }; } });
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

test("the app is the workspace: homepage goes to the workspace, docs and other sites open in the browser", async () => {
  const { linkTarget, downloadAllowed } = require("../desktop/policy");
  const origin = "https://team.example";
  assert.deepEqual([origin, origin + "/", origin + "/#download"].map(url => linkTarget(url, origin)), ["home", "home", "home"]);
  assert.deepEqual([origin + "/workspace", origin + "/s/room", origin + "/docsx"].map(url => linkTarget(url, origin)), ["app", "app", "app"]);
  assert.deepEqual([origin + "/docs", origin + "/docs/download-install"].map(url => linkTarget(url, origin)), ["browser", "browser"]);
  // Continue with Google: Google sign-in only works in the browser.
  assert.equal(linkTarget(origin + "/login?next=%2Fworkspace&desktop=01a16797-8cd1", origin), "browser");
  assert.equal(linkTarget(origin + "/login?next=%2Fworkspace", origin), "app");
  assert.equal(linkTarget("https://github.com", origin), "external");
  assert.equal(linkTarget("file:///etc/passwd", origin), "blocked");
  assert.deepEqual([origin + "/api/file", "blob:" + origin + "/1"].map(url => downloadAllowed(url, origin)), [true, true]);
  assert.deepEqual(["https://evil.test/a.csv", "blob:https://evil.test/1", "blob:" + origin + ".evil.test/1", "data:text/csv,a"].map(url => downloadAllowed(url, origin)), [false, false, false, false]);

  const instance = harness();
  const opened = [], loaded = [];
  instance.electron.shell.openExternal = async url => { opened.push(url); };
  const window = mockWindow(origin + "/workspace");
  window.loadURL = async url => { loaded.push(url); };
  instance.security(window);
  const navigate = url => { let stopped = false; window.webContents.emit("will-navigate", { url, preventDefault() { stopped = true; } }, url); return stopped; };
  assert.equal(navigate(origin + "/s/room"), false, "workspace pages open in the app");
  assert.equal(navigate(origin + "/"), true);
  assert.deepEqual(loaded, [origin + "/workspace"], "the homepage is replaced by the workspace");
  window.webContents.emit("did-navigate-in-page", {}, origin + "/", true);
  assert.equal(loaded.length, 2, "also after a client-side link to the homepage");
  assert.equal(navigate(origin + "/docs/download-install"), true);
  assert.equal(navigate("https://github.com/x"), true, "a page cannot navigate the app to another site");
  assert.equal(window.webContents.openWindow({ url: origin + "/#download" }).action, "deny");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [origin + "/docs/download-install", origin + "/#download"], "docs and the download page open in the browser");
  window.webContents.openWindow({ url: origin + "/s/other" });
  assert.equal(loaded.at(-1), origin + "/s/other", "a new-tab workspace link opens in the app window");

  const check = window.webContents.session.checkPermission;
  assert.equal(check(null, "clipboard-sanitized-write", origin), true, "Copy buttons work");
  assert.equal(check(null, "clipboard-sanitized-write", "https://evil.test"), false);
  assert.equal(check(null, "media", origin), false);
  window.webContents.session.requestPermission(null, "geolocation", allowed => assert.equal(allowed, false), { requestingUrl: origin + "/workspace" });
  const download = url => { let stopped = false; window.webContents.session.emit("will-download", { preventDefault() { stopped = true; } }, { getURL: () => url }); return stopped; };
  assert.equal(download("blob:" + origin + "/export"), false, "exports save through the Save dialog");
  assert.equal(download("https://evil.test/payload.exe"), true);
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

test("the workspace can set and remove AI-tool keys on this computer, never read their values", () => {
  const instance = harness();
  const workspace = mockWindow("https://team.example/workspace");
  const setup = mockWindow(instance.setupUrl);
  instance.setWindows(workspace, setup);
  const sender = { sender: workspace.webContents, senderFrame: workspace.webContents.mainFrame };
  const set = instance.handlers.get("desktop:secret-set"), names = instance.handlers.get("desktop:secret-names"), remove = instance.handlers.get("desktop:secret-remove");
  assert.throws(() => set({ sender: setup.webContents, senderFrame: setup.webContents.mainFrame }, "GITHUB_TOKEN", "x"), /Not allowed/);
  assert.throws(() => names({ sender: workspace.webContents, senderFrame: { url: "https://team.example" } }), /Not allowed/);
  assert.match(set(sender, "GITHUB_TOKEN", "x").error, /Connect this computer first/);
  instance.writes.set(path.join("/profile", "runner.json"), { value: JSON.stringify({ server: "https://team.example", token: "t", dataDir: "/profile/runner-data/abc" }) });
  const saved = set(sender, "GITHUB_TOKEN", "ghp_secret");
  assert.equal(saved.ok, true);
  assert.deepEqual([...saved.names], ["GITHUB_TOKEN"]);
  const file = instance.writes.get(path.join("/profile/runner-data/abc", "secrets.json"));
  assert.equal(file.options.mode, 0o600);
  assert.deepEqual(JSON.parse(file.value), { version: 1, secrets: { GITHUB_TOKEN: "ghp_secret" } });
  assert.equal(set(sender, "github token", "x").ok, false);
  assert.equal(set(sender, "EMPTY", "").ok, false);
  const listed = names(sender);
  assert.deepEqual([...listed.names], ["GITHUB_TOKEN"]);
  assert.doesNotMatch(JSON.stringify(listed), /ghp_secret/);
  assert.deepEqual([...remove(sender, "GITHUB_TOKEN").names], []);
});

test("sign-in works in the app: Clerk's bot check may load in a frame, nothing else from elsewhere", () => {
  const { frameAllowed } = require("../desktop/policy");
  const origin = "https://multicode.in";
  assert.deepEqual([origin + "/login", "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc"].map(url => frameAllowed(url, origin)), [true, true]);
  assert.deepEqual(["https://evil.test/", "http://challenges.cloudflare.com/x", "https://challenges.cloudflare.com.evil.test/", "https://a:b@challenges.cloudflare.com/", "javascript:alert(1)"].map(url => frameAllowed(url, origin)), [false, false, false, false, false]);
  const instance = harness();
  const window = mockWindow(origin);
  instance.security(window);
  const frame = (url) => { let blocked = false; window.webContents.emit("will-frame-navigate", { url, isMainFrame: false, preventDefault() { blocked = true; } }); return blocked; };
  assert.equal(frame("https://challenges.cloudflare.com/turnstile/if/ov2"), false);
  assert.equal(frame("https://evil.test/frame"), true);
});

test("installers open multicode.in; only --setup test builds ask for an address", () => {
  const prepare = fs.readFileSync("desktop/prepare.mjs", "utf8");
  assert.match(prepare, /process\.argv\.includes\("--setup"\) \? "" : process\.env\.DESKTOP_WORKSPACE_URL \?\? "https:\/\/multicode\.in"/);
  assert.match(fs.readFileSync("desktop/package.mjs", "utf8"), /if \(setup\) \{\s*env\.DESKTOP_WORKSPACE_URL = "";/);
  // With an address built in, Desktop settings has nothing to type.
  assert.match(fs.readFileSync("desktop/setup.js", "utf8"), /connect-form"\)\.hidden = !!state\.builtIn/);
});

test("the runner can find Node and npm-installed AI tools on Windows", () => {
  const env = runnerEnvironment({ PATH: "C:\\Windows", APPDATA: "C:\\Users\\a\\AppData\\Roaming", PATHEXT: ".COM;.EXE;.CMD", ProgramFiles: "C:\\Program Files" }, "C:\\cfg");
  assert.equal(env.APPDATA, "C:\\Users\\a\\AppData\\Roaming");
  assert.equal(env.PATHEXT, ".COM;.EXE;.CMD");
  assert.equal(env.ProgramFiles, "C:\\Program Files");
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
  assert.match(packagedExecutable("output", "linux", "x64"), /linux-unpacked[/\\]multicode-ai$/);
  assert.match(packagedExecutable("output", "win32", "arm64"), /win-arm64-unpacked[/\\]Multicode AI\.exe$/);
  assert.match(packagedExecutable("output", "darwin", "x64"), /mac[/\\]Multicode AI\.app[/\\]Contents[/\\]MacOS[/\\]Multicode AI$/);
});

test("a configured build opens the workspace instead of the setup screen", () => {
  const main = fs.readFileSync("desktop/main.js", "utf8");
  assert.match(main, /if\s*\(settings\.url\)\s*void connect\(\);\s*else showSetup\(\);/);
  assert.doesNotMatch(main, /showSetup\(\);\s*if\s*\(settings\.url\)\s*void connect\(\);/);
});

test("a blank value in the signing template is treated as unconfigured", async () => {
  const { localReleaseEnvironment } = await import("../desktop/release-preflight.mjs");
  const file = path.join(require("node:os").tmpdir(), "desktop-signing-" + process.pid + ".env");
  fs.writeFileSync(file, "CSC_LINK=\nCSC_NAME=\nAPPLE_TEAM_ID=TEAM\n");
  try {
    const env = localReleaseEnvironment({}, file);
    assert.equal("CSC_LINK" in env, false, "an empty CSC_LINK must not reach electron-builder as a certificate path");
    assert.equal("CSC_NAME" in env, false);
    assert.equal(env.APPLE_TEAM_ID, "TEAM");
  } finally { fs.rmSync(file, { force: true }); }
});

test("a signing secret CI expands to an empty string counts as not configured", async () => {
  const { localReleaseEnvironment } = await import("../desktop/release-preflight.mjs");
  const env = localReleaseEnvironment({ CSC_LINK: "", APPLE_API_KEY: "", AZURE_CLIENT_SECRET: "", APPLE_TEAM_ID: "TEAM", OTHER: "" }, "/nonexistent/desktop-signing.env");
  for (const key of ["CSC_LINK", "APPLE_API_KEY", "AZURE_CLIENT_SECRET"]) assert.equal(key in env, false, key + " must not reach electron-builder empty");
  assert.equal(env.APPLE_TEAM_ID, "TEAM");
  assert.equal(env.OTHER, "", "only signing settings are filtered");
});

test("Windows builds sign with Azure Trusted Signing once its account is configured", () => {
  const { winSigning } = require("../desktop/targets.cjs");
  assert.deepEqual(winSigning({}), {}, "unsigned, or signed from a certificate file, otherwise");
  assert.deepEqual(winSigning({ AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/" }), {}, "needs the whole account");
  assert.deepEqual(winSigning({ AZURE_TRUSTED_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/", AZURE_TRUSTED_SIGNING_ACCOUNT: "multicode", AZURE_TRUSTED_SIGNING_PROFILE: "public", AZURE_TRUSTED_SIGNING_PUBLISHER: "Salk AI" }),
    { azureSignOptions: { endpoint: "https://eus.codesigning.azure.net/", codeSigningAccountName: "multicode", certificateProfileName: "public", publisherName: "Salk AI" } });
});

test("macOS previews only fall back to ad-hoc signing when no certificate is configured", () => {
  const { macSigning } = require("../desktop/targets.cjs");
  const notarization = { APPLE_ID: "releases@example.com", APPLE_APP_SPECIFIC_PASSWORD: "secret", APPLE_TEAM_ID: "TEAM" };
  assert.deepEqual(macSigning({}, false), { hardenedRuntime: false, notarize: false, identity: "-" });
  assert.deepEqual(macSigning({ CSC_NAME: "-" }, false), { hardenedRuntime: false, notarize: false, identity: "-" });
  for (const certificate of [{ CSC_NAME: "Developer ID Application: Example" }, { CSC_LINK: "certificate.p12" }]) {
    assert.deepEqual(macSigning(certificate, false), { hardenedRuntime: true, notarize: false });
    assert.deepEqual(macSigning({ ...certificate, ...notarization }, false), { hardenedRuntime: true, notarize: true });
  }
  assert.deepEqual(macSigning({}, true), { hardenedRuntime: true, notarize: true });
  assert.doesNotMatch(fs.readFileSync("desktop/builder.cjs", "utf8"), /identity: "-"/);
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


test("worktree folder controls are setup-only and choosing a location preserves pairing", async () => {
  const instance = harness();
  const workspace = mockWindow("https://team.example/workspace"), setup = mockWindow(instance.setupUrl);
  instance.setWindows(workspace, setup);
  const local = { sender: setup.webContents, senderFrame: setup.webContents.mainFrame };
  const remote = { sender: workspace.webContents, senderFrame: workspace.webContents.mainFrame };
  for (const channel of ["desktop:open-workspaces", "desktop:choose-workspaces"]) await assert.rejects(instance.handlers.get(channel)(remote), /Not allowed/);
  instance.electron.dialog.showOpenDialog = async () => ({ canceled:false,filePaths:[path.resolve("local-worktrees")] });
  await instance.handlers.get("desktop:choose-workspaces")(local);
  let state = await instance.handlers.get("desktop:status")(local);
  assert.equal(state.workspacesDir,path.resolve("local-worktrees"));
  let opened;
  instance.electron.shell.openPath = async directory => { opened=directory; return ""; };
  await instance.handlers.get("desktop:open-workspaces")(local);
  assert.equal(opened,state.workspacesDir);
  instance.electron.dialog.showMessageBox = async () => ({response:1});
  await instance.handlers.get("desktop:pair")(remote,"RN-ABCD-1234");
  const config = JSON.parse([...instance.writes.entries()].find(([file])=>file.endsWith("runner.json"))[1].value);
  assert.equal(config.workspacesDir,state.workspacesDir);
  assert.equal(config.token,"private-device-token");
  state = await instance.handlers.get("desktop:status")(local);
  assert.equal(state.workspacesLocked,true);
  assert.equal((await instance.handlers.get("desktop:choose-workspaces")(local)).ok,false);
  assert.equal((await instance.handlers.get("desktop:status")(local)).workspacesDir,config.workspacesDir);
  instance.toggleRunner();
  instance.children[0].emit("exit", 0);
  instance.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.resolve("new-worktrees")] });
  await instance.handlers.get("desktop:choose-workspaces")(local);
  const updated = JSON.parse([...instance.writes.entries()].find(([file]) => file.endsWith("runner.json"))[1].value);
  assert.equal(updated.workspacesDir, path.resolve("new-worktrees"));
  assert.equal(updated.token, config.token);
  assert.equal(updated.dataDir, config.dataDir);
  assert.equal(updated.server, config.server);
});

function automaticConnectionFixture(initial = null) {
  const { createAutoConnection } = require('../desktop/connection');
  let config = initial;
  const saved = new Map();
  const state = { user: 'alice', enabled: true, running: false, starts: 0, stops: 0, pairs: 0, revoked: false, messages: [], requests: [], held: null };
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const session = { fetch: async (url, options) => {
    state.requests.push({url,options});
    if (url.endsWith('/api/auth/me')) return reply({user:state.user ? {id:state.user} : null});
    if (url.endsWith('/api/runner/pairing')) { if (state.held) await state.held; return reply({code:'RN-ABCD-EFGH'}); }
    throw new Error('Unexpected URL');
  } };
  const connection = createAutoConnection({
    context: () => ({origin:'https://team.example',session}),
    readConfig: () => config,
    readSaved: (origin,user) => saved.get(origin + user) ?? null,
    remember: value => saved.set(value.server + value.userId,value),
    saveConfig: value => { config=value; saved.set(value.server + value.userId,value); },
    newConfig: (server,userId,deviceId,token) => ({server,userId,deviceId,token,dataDir:'/private/' + userId}),
    deviceInfo: () => ({name:'Test desktop',platform:'test',version:'1'}),
    enabled: () => state.enabled, running: () => state.running, pairing: () => false, quitting: () => false, disabled: () => false,
    start: () => { if (!state.running) {state.running=true;state.starts++;} },
    stop: () => { if (state.running) {state.running=false;state.stops++;} },
    report: message => state.messages.push(message),
    fetch: async (url,options) => {
      state.requests.push({url,options});
      if (url.endsWith('/api/runner/me')) {
        const owner=options.headers.authorization.includes('bob') ? 'bob' : 'alice';
        return state.revoked ? reply({},401) : reply({device:{id:'device-'+owner,userId:owner}});
      }
      if (url.endsWith('/api/runner/pair')) {state.pairs++;return reply({token:'token-' + state.user,device:{id:'device-' + state.user,userId:state.user}});}
      throw new Error('Unexpected URL');
    },
  });
  return {connection,state,saved,config:()=>config};
}

test('desktop automatically pairs once after sign-in and reuses the connection across launches', async () => {
  const f=automaticConnectionFixture();
  await Promise.all([f.connection.sync(),f.connection.sync()]);
  assert.equal(f.state.pairs,1); assert.equal(f.state.starts,1);
  assert.equal(f.config().userId,'alice'); assert.equal(f.connection.canStart(f.config()),true);
  assert.equal(f.state.requests[0].options.credentials,'include');
  assert.ok(f.state.requests.every(request=>request.options.redirect==='error'));
  await f.connection.sync(); assert.equal(f.state.pairs,1); assert.equal(f.state.starts,1);
  const restarted=automaticConnectionFixture(f.config());
  await restarted.connection.sync(); assert.equal(restarted.state.pairs,0); assert.equal(restarted.state.starts,1);
});

test('legacy connection migration reuses the signed-in account profile instead of pairing another device', async () => {
  const origin='https://team.example';
  const f=automaticConnectionFixture({server:origin,token:'token-alice',dataDir:'/legacy'});
  f.saved.set(origin+'bob',{server:origin,userId:'bob',deviceId:'device-bob',token:'token-bob',dataDir:'/private/bob'});
  f.state.user='bob';
  await f.connection.sync();
  assert.equal(f.state.pairs,0);
  assert.equal(f.config().token,'token-bob');
  assert.equal(f.config().deviceId,'device-bob');
  assert.equal(f.config().dataDir,'/private/bob');
  assert.equal(f.saved.get(origin+'alice').token,'token-alice');
  assert.equal(f.state.starts,1);
});

test('sign-out drains the runner, account switches use separate connections, and a manual pause persists', async () => {
  const f=automaticConnectionFixture(); await f.connection.sync(); const alice=f.config();
  f.state.user=null; f.connection.invalidate(); await f.connection.sync();
  assert.equal(f.state.running,false); assert.equal(f.connection.canStart(alice),false);
  f.state.user='bob'; f.connection.invalidate(); await f.connection.sync();
  assert.equal(f.config().userId,'bob'); assert.notEqual(f.config().dataDir,alice.dataDir); assert.equal(f.state.pairs,2);
  f.state.user='alice'; f.connection.invalidate(); await f.connection.sync();
  assert.equal(f.config().token,alice.token); assert.equal(f.state.pairs,2);
  f.state.enabled=false;f.state.running=false;
  await f.connection.sync();assert.equal(f.state.running,false);
});

test('revoked device connections are not silently recreated', async () => {
  const f=automaticConnectionFixture(); await f.connection.sync();
  f.state.revoked=true; await f.connection.sync();
  assert.equal(f.state.running,false); assert.equal(f.state.pairs,1);
  assert.match(f.state.messages.at(-1),/revoked/);
  await f.connection.sync(); assert.equal(f.state.pairs,1);
});

test('sign-out during automatic pairing cannot start or save a stale connection', async () => {
  const f=automaticConnectionFixture(); let release;
  f.state.held=new Promise(resolve=>{release=resolve;});
  const pending=f.connection.sync();
  while (!f.state.requests.some(request=>request.url.endsWith('/pairing'))) await new Promise(resolve=>setImmediate(resolve));
  f.state.user=null; f.connection.invalidate(); release(); await pending; await f.connection.sync();
  assert.equal(f.state.starts,0); assert.equal(f.config(),null); assert.equal(f.state.pairs,0);
});
