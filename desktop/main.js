const { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain, dialog, utilityProcess, screen } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { workspaceUrl, sameOrigin, externalUrl, linkTarget, downloadAllowed, waitForServer, runnerEnvironment } = require("./policy");
const { createAutoConnection } = require("./connection");

app.setName("Multicode AI");
// userData is derived from the app name, so the Multicode AI rename would
// otherwise strand an existing install's workspace address, device pairing and
// runner state in a directory nothing reads any more. Keep using the old one
// when it is already there; new installs get the current name. The directory
// named "Multiplayer AI" below is the pre-rename product name, not a typo.
const legacyUserData = path.join(path.dirname(app.getPath("userData")), "Multiplayer AI");
if (!fs.existsSync(app.getPath("userData")) && fs.existsSync(legacyUserData)) {
  app.setPath("userData", legacyUserData);
}
const setupUrl = pathToFileURL(path.join(__dirname, "setup.html")).href;
const settingsPath = path.join(app.getPath("userData"), "desktop.json");
const runnerPath = path.join(app.getPath("userData"), "runner.json");
const release = JSON.parse(fs.readFileSync(path.join(__dirname, "release.json"), "utf8"));
// Same reasoning for the visible worktrees: an existing checkout must not
// appear to vanish because the folder the product suggests changed name.
const legacyWorkspacesDir = path.join(os.homedir(), "multiplayer-ai", "workspaces");
const renamedWorkspacesDir = path.join(os.homedir(), "multicode-ai", "workspaces");
const defaultWorkspacesDir = !fs.existsSync(renamedWorkspacesDir) && fs.existsSync(legacyWorkspacesDir)
  ? legacyWorkspacesDir
  : renamedWorkspacesDir;
let settings = { url: "", runnerEnabled: true, workspacesDir: defaultWorkspacesDir };
let mainWindow = null;
let setupWindow = null;
let tray = null;
let runnerProcess = null;
let serverProcess = null;
let connecting = null;
let pairing = false;
let quitting = false;
let runnerState = "not paired";
let message = "";
let updater = null;
let updateTimer = null;
let updateReady = false;
let updateBusy = false;
let workspaceSession = null;
let connectionTimer = null;

function readRunnerConfig(file = runnerPath) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
const connectionKey = (server, userId) => createHash("sha256").update(server + "\0" + userId).digest("hex");
const savedConnectionPath = (server, userId) => path.join(app.getPath("userData"), "connections", connectionKey(server, userId) + ".json");
function writePrivateConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(config), { mode: 0o600, flush: true });
  fs.renameSync(file + ".tmp", file);
}
function rememberConnection(config) {
  if (config.userId) writePrivateConfig(savedConnectionPath(config.server, config.userId), config);
}
function saveRunnerConfig(config) {
  rememberConnection(config);
  writePrivateConfig(runnerPath, config);
}

try {
  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  settings = { url: workspaceUrl(saved.url, !app.isPackaged), runnerEnabled: saved.runnerEnabled !== false || !readRunnerConfig(),
    workspacesDir: typeof saved.workspacesDir === "string" && path.isAbsolute(saved.workspacesDir) ? saved.workspacesDir : defaultWorkspacesDir };
} catch {
  try { settings.url = workspaceUrl(release.workspaceUrl, !app.isPackaged); } catch {}
}
if (!app.isPackaged && process.env.APP_URL) {
  try { settings.url = workspaceUrl(process.env.APP_URL, true); }
  catch { message = "APP_URL is invalid. Enter a valid workspace address."; settings.url = ""; }
}

const autoConnection = createAutoConnection({
  context: () => settings.url && workspaceSession ? { origin: settings.url, session: workspaceSession } : null,
  readConfig: readRunnerConfig,
  readSaved: (server, userId) => readRunnerConfig(savedConnectionPath(server, userId)),
  remember: rememberConnection,
  saveConfig: saveRunnerConfig,
  newConfig: (server, userId, deviceId, token) => ({ server, userId, deviceId, token, name: os.hostname(),
    dataDir: path.join(app.getPath("userData"), "runner-data", connectionKey(server, userId)), workspacesDir: settings.workspacesDir }),
  deviceInfo: () => ({ name: os.hostname().slice(0, 100), platform: process.platform, version: app.getVersion() }),
  enabled: () => settings.runnerEnabled,
  running: () => !!runnerProcess,
  pairing: () => pairing,
  quitting: () => quitting,
  disabled: () => process.env.DESKTOP_RUNNER === "0",
  start: startRunner, stop: stopRunner, report, fetch: (...args) => fetch(...args),
});

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporary = settingsPath + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(settings), { mode: 0o600 });
  fs.renameSync(temporary, settingsPath);
}

function workspacesDir() {
  try {
    const config = JSON.parse(fs.readFileSync(runnerPath, "utf8"));
    if (typeof config.workspacesDir === "string" && path.isAbsolute(config.workspacesDir)) return config.workspacesDir;
  } catch {}
  return settings.workspacesDir;
}

async function openWorkspacesFolder() {
  const directory = workspacesDir();
  fs.mkdirSync(directory, { recursive: true });
  const error = await shell.openPath(directory);
  if (error) throw new Error("Could not open the workspaces folder: " + error);
}

function paired() {
  try {
    const config = JSON.parse(fs.readFileSync(runnerPath, "utf8"));
    return config.server === settings.url && typeof config.token === "string" && Boolean(config.token);
  } catch { return false; }
}

function report(value) {
  message = value;
}

function security(window, local = false) {
  const contents = window.webContents;
  if (local) {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const eventName of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
      contents.on(eventName, (event, url) => {
        if ((typeof url === "string" ? url : event.url) !== setupUrl) event.preventDefault();
      });
    }
  } else {
    // The app is the workspace: its pages open here, the homepage is never shown
    // (the workspace is), and docs and other sites open in the browser.
    const route = (url, { newWindow = false, redirect = false } = {}) => {
      const target = linkTarget(url, settings.url);
      if (target === "app") return newWindow ? void window.loadURL(url) : true;
      if (target === "home" && !newWindow) return void window.loadURL(new URL("/workspace", settings.url).href);
      if (redirect) return false;
      if (target === "home" || target === "browser") void shell.openExternal(url).catch(() => report("Could not open the link."));
      // Other sites only from a new-tab link, and only after asking; a page
      // navigating itself away is simply stopped, so it cannot raise dialogs.
      else if (target === "external" && newWindow) void openExternal(url);
      return false;
    };
    contents.setWindowOpenHandler(({ url }) => { route(url, { newWindow: true }); return { action: "deny" }; });
    contents.on("will-navigate", (event, url) => { if (route(typeof url === "string" ? url : event.url) !== true) event.preventDefault(); });
    contents.on("will-redirect", (event, url) => { if (linkTarget(typeof url === "string" ? url : event.url, settings.url) !== "app") event.preventDefault(); });
    contents.on("will-frame-navigate", (event) => { if (!event.isMainFrame && linkTarget(event.url, settings.url) !== "app") event.preventDefault(); });
    // Client-side navigation (a link to "/" inside the app) changes the URL without loading.
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame && linkTarget(url, settings.url) === "home") void window.loadURL(new URL("/workspace", settings.url).href);
    });
  }
  contents.on("will-attach-webview", event => event.preventDefault());
  // Copy buttons need clipboard writes; nothing else (camera, location…) is ever granted.
  const allowed = (permission, origin) => !local && permission === "clipboard-sanitized-write" && sameOrigin(origin, settings.url);
  contents.session.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, details?.requestingUrl ? new URL(details.requestingUrl).origin : "")));
  contents.session.setPermissionCheckHandler((_contents, permission, origin) => allowed(permission, origin));
  // Exports and files from the workspace save through the usual Save dialog.
  contents.session.on("will-download", (event, item) => {
    if (local || !downloadAllowed(item.getURL(), settings.url)) event.preventDefault();
  });
}

async function openExternal(url) {
  if (!externalUrl(url)) return;
  const result = await dialog.showMessageBox({
    type: "question",
    message: "Open this link in your browser?",
    detail: url.slice(0, 500),
    buttons: ["Cancel", "Open link"],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response === 1) await shell.openExternal(url).catch(() => report("Could not open the link."));
}

function showSetup() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 800, height: 870, minWidth: 440, minHeight: 500,
    title: "Multicode AI — Desktop settings", backgroundColor: "#151515",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "setup-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, partition: "desktop-settings" },
  });
  security(setupWindow, true);
  void setupWindow.loadURL(setupUrl);
  setupWindow.on("closed", () => { setupWindow = null; });
}

/** The workspace window opens where it was last closed, if that place is still on a screen. */
const windowStatePath = path.join(app.getPath("userData"), "window.json");
function savedWindowBounds() {
  try {
    const saved = JSON.parse(fs.readFileSync(windowStatePath, "utf8"));
    const bounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    if (!Object.values(bounds).every(Number.isInteger) || bounds.width < 700 || bounds.height < 500) return null;
    const area = screen.getDisplayMatching(bounds).workArea;
    const visible = bounds.x < area.x + area.width - 100 && bounds.x + bounds.width > area.x + 100 && bounds.y >= area.y - 10 && bounds.y < area.y + area.height - 100;
    return visible ? { ...bounds, maximized: saved.maximized === true } : null;
  } catch {
    return null;
  }
}
function saveWindowBounds(window) {
  try {
    if (window.isDestroyed() || window.isMinimized()) return;
    fs.writeFileSync(windowStatePath, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
  } catch { /* not remembered */ }
}

function createWorkspace() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const bounds = savedWindowBounds();
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1440, height: bounds?.height ?? 940, ...(bounds ? { x: bounds.x, y: bounds.y } : {}), minWidth: 700, minHeight: 500,
    show: false, title: "Multicode AI", backgroundColor: "#151515",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  security(mainWindow);
  if (bounds?.maximized) mainWindow.maximize();
  // Tells the website this is the app, so it never serves the marketing homepage here.
  mainWindow.webContents.setUserAgent(`${mainWindow.webContents.getUserAgent()} MulticodeDesktop/${app.getVersion()}`);
  mainWindow.on("close", () => saveWindowBounds(mainWindow));
  if (workspaceSession !== mainWindow.webContents.session) {
    workspaceSession = mainWindow.webContents.session;
    workspaceSession.cookies.on("changed", (_event, cookie) => {
      if ((!/^__session(?:_|$)/.test(cookie.name) && cookie.name !== "ma_auth") || !settings.url) return;
      const host = new URL(settings.url).hostname, domain = cookie.domain.replace(/^\./, "");
      if (host === domain || host.endsWith("." + domain)) autoConnection.invalidate();
    });
  }
  mainWindow.webContents.on("did-finish-load", () => { void autoConnection.sync(); });
  mainWindow.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) {
      report("The workspace could not load. Check your connection and reopen it.");
      showSetup();
    }
  });
  mainWindow.webContents.on("render-process-gone", () => {
    report("The workspace stopped responding. Reopen it to recover.");
    showSetup();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow;
}

async function connect() {
  connecting?.abort();
  const controller = new AbortController();
  connecting = controller;
  if (!settings.url) { showSetup(); return; }
  report("Connecting to your workspace…");
  const window = createWorkspace();
  // Nothing else is on screen during a normal launch, so present the window while the
  // readiness check runs rather than leaving the user with no sign the app started.
  const opening = !window.webContents.getURL();
  if (opening) window.show();
  try {
    await waitForServer(settings.url, { timeoutMs: serverProcess ? 90000 : 15000, signal: controller.signal });
    if (controller.signal.aborted || quitting || window.isDestroyed()) return;
    await window.loadURL(new URL("/workspace", settings.url).href);
    if (controller.signal.aborted || window.isDestroyed() || quitting) return;
    window.show();
    window.focus();
    report("Connected to " + settings.url);
    setupWindow?.hide();
    void autoConnection.sync();
  } catch (error) {
    if (!controller.signal.aborted && !quitting) {
      report(error.message);
      if (opening && !window.isDestroyed()) window.destroy();
      showSetup();
    }
  }
}

function showWorkspace() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    void connect();
  }
}

function updateTray() {
  tray?.setToolTip("Multicode AI — Runner: " + runnerState);
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: "Runner: " + runnerState, enabled: false },
    { label: "Open workspace", click: showWorkspace },
    { label: "Desktop settings", click: showSetup },
    { label: "Open local worktrees", click: () => void openWorkspacesFolder().catch(error => report(error.message)) },
    { type: "separator" },
    { label: settings.runnerEnabled ? "Pause after current task" : "Resume runner", enabled: paired() && runnerState !== "stopping", click: toggleRunner },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

function setRunnerState(value) {
  runnerState = value;
  updateTray();
}

function startRunner() {
  if (quitting || runnerProcess || !settings.runnerEnabled || !paired() || process.env.DESKTOP_RUNNER === "0") return;
  if (!autoConnection.canStart(readRunnerConfig())) { void autoConnection.sync(); return; }
  try {
    const entry = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", "runner.cjs") : path.join(__dirname, "runner.cjs");
    const child = utilityProcess.fork(entry, ["start"], {
      cwd: app.getPath("userData"), env: runnerEnvironment(process.env, runnerPath), stdio: "pipe", serviceName: "Multicode AI Runner",
    });
    runnerProcess = child;
    setRunnerState("connecting");
    let buffer = "";
    child.stdout.on("data", chunk => {
      buffer = (buffer + chunk.toString()).slice(-8192);
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (runnerState === "stopping") continue;
        if (line.includes(": claimed")) setRunnerState("running");
        else if (line.includes(": completed") || line.includes(": failed") || line.includes("online as")) setRunnerState("online");
      }
    });
    child.stderr.on("data", () => { report("Runner reported an error. Check your CLI setup and device connection."); });
    child.on("error", () => { report("The local runner could not start. Reconnect it in Desktop settings."); });
    child.on("exit", code => {
      if (runnerProcess !== child) return;
      runnerProcess = null;
      setRunnerState("paused");
      if (code !== 0) {
        report("Computer connection interrupted. Retrying automatically; check that Git and your AI tools are installed.");
      }
      if (quitting) app.quit();
      else if (code === 0 && settings.runnerEnabled) void autoConnection.sync();
    });
  } catch {
    setRunnerState("paused");
    report("Runner could not start. Reinstall the desktop app or contact your administrator.");
  }
}

function stopRunner() {
  if (!runnerProcess || runnerState === "stopping") return;
  setRunnerState("stopping");
  runnerProcess.postMessage({ type: "shutdown" });
  report("Finishing the current or already-requested task before stopping. No new task requests will be started.");
}

function toggleRunner() {
  if (!paired() || runnerState === "stopping" || quitting) return;
  settings.runnerEnabled = !settings.runnerEnabled;
  saveSettings();
  if (settings.runnerEnabled) startRunner();
  else stopRunner();
  updateTray();
}

function requireSetup(event) {
  if (!setupWindow || event.sender !== setupWindow.webContents || event.senderFrame !== setupWindow.webContents.mainFrame || event.senderFrame.url !== setupUrl) {
    throw new Error("Not allowed.");
  }
}

function setupHandler(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    requireSetup(event);
    try { return await handler(...args); }
    catch (error) { report(error.message); return { ok: false }; }
  });
}

// Keys for AI tools (MCP servers and plugins configured in the workspace),
// kept only in this computer's runner data folder. The workspace page can set
// or remove a key and see which names exist; values never go back to it.
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
function requireWorkspace(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !sameOrigin(event.senderFrame.url, settings.url)) throw new Error("Not allowed.");
}
function runnerSecretsFile() {
  const dataDir = readRunnerConfig()?.dataDir;
  if (typeof dataDir !== "string" || !dataDir) throw new Error("Connect this computer first, then add keys.");
  return path.join(dataDir, "secrets.json");
}
function readRunnerSecrets(file) {
  try {
    const secrets = JSON.parse(fs.readFileSync(file, "utf8")).secrets;
    return secrets && typeof secrets === "object" && !Array.isArray(secrets) ? secrets : {};
  } catch { return {}; }
}
function changeRunnerSecret(name, value) {
  if (typeof name !== "string" || !SECRET_NAME.test(name)) throw new Error("Use capital letters, numbers and _ for the name, e.g. GITHUB_TOKEN.");
  if (value !== null && (typeof value !== "string" || !value || Buffer.byteLength(value) > 16384 || value.includes("\0"))) throw new Error("The value is empty or too long.");
  const file = runnerSecretsFile(), secrets = readRunnerSecrets(file);
  if (value === null) delete secrets[name]; else secrets[name] = value;
  writePrivateConfig(file, { version: 1, secrets });
  runnerProcess?.postMessage({ type: "secrets-changed" });
  return { ok: true, names: Object.keys(secrets).filter(key => SECRET_NAME.test(key)).sort() };
}

function registerIpc() {
  setupHandler("desktop:status", () => ({ url: settings.url, enabled: settings.runnerEnabled, paired: paired(), runner: runnerState, message, version: app.getVersion(), workspacesDir: workspacesDir(), workspacesLocked: !!runnerProcess || pairing }));
  setupHandler("desktop:open-workspaces", openWorkspacesFolder);
  setupHandler("desktop:choose-workspaces", async () => {
    if (runnerProcess || pairing || autoConnection.busy()) throw new Error("Pause the runner and wait for it to stop connecting before changing the worktrees folder.");
    const choice = await dialog.showOpenDialog(setupWindow, {
      title: "Choose the folder for local worktrees", defaultPath: workspacesDir(),
      properties: ["openDirectory", "createDirectory"], buttonLabel: "Use this folder",
    });
    if (choice.canceled || !choice.filePaths[0]) return;
    if (runnerProcess || pairing || autoConnection.busy() || quitting) throw new Error("Runner state changed. Pause it and choose the folder again.");
    const directory = path.resolve(choice.filePaths[0]);
    let config;
    try { config = JSON.parse(fs.readFileSync(runnerPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("Runner configuration needs recovery before changing its folder."); }
    if (config) {
      saveRunnerConfig({ ...config, workspacesDir: directory });
    }
    settings.workspacesDir = directory;
    saveSettings();
    report("New worktrees will use this folder. Existing worktrees keep their saved locations.");
  });
  setupHandler("desktop:connect", async value => {
    if (runnerProcess || pairing || autoConnection.busy()) throw new Error("Pause the runner and wait for it to stop connecting before changing workspaces.");
    const url = workspaceUrl(value, !app.isPackaged);
    if (url !== settings.url) {
      mainWindow?.destroy();
      mainWindow = null;
    }
    settings.url = url;
    autoConnection.invalidate();
    saveSettings();
    setRunnerState(paired() ? "paused" : "not paired");
    await connect();
  });
  setupHandler("desktop:retry", connect);
  setupHandler("desktop:toggle-runner", toggleRunner);
  setupHandler("desktop:updates", checkUpdates);
  ipcMain.handle("desktop:secret-names", event => {
    requireWorkspace(event);
    try { return { ok: true, names: Object.keys(readRunnerSecrets(runnerSecretsFile())).filter(key => SECRET_NAME.test(key)).sort() }; }
    catch (error) { return { ok: false, error: error.message, names: [] }; }
  });
  ipcMain.handle("desktop:secret-set", (event, name, value) => {
    requireWorkspace(event);
    try { return changeRunnerSecret(name, value); } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("desktop:secret-remove", (event, name) => {
    requireWorkspace(event);
    try { return changeRunnerSecret(name, null); } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle("desktop:pair", async (event, code) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !sameOrigin(event.senderFrame.url, settings.url)) throw new Error("Not allowed.");
    if (pairing || runnerProcess || autoConnection.busy() || quitting) return { ok: false, error: "Pause the runner and wait for it to stop connecting before pairing again." };
    if (typeof code !== "string" || !/^RN-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return { ok: false, error: "Invalid pairing code." };
    pairing = true;
    const origin = settings.url;
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: "warning", message: "Allow this workspace to run your AI tasks on this computer?",
        detail: origin + "\n\nAgents run commands with your user permissions and may access files and provider credentials. Only connect a server you trust. Pairing replaces this desktop's previous device connection. You can pause it in Desktop settings.",
        buttons: ["Cancel", "Pair and enable runner"], defaultId: 0, cancelId: 0,
      });
      if (result.response !== 1 || origin !== settings.url || quitting) return { ok: false, error: "Pairing cancelled." };
      const response = await fetch(origin + "/api/runner/pair", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: os.hostname(), platform: process.platform, version: app.getVersion() }),
        signal: AbortSignal.timeout(15000), redirect: "error",
      });
      if (!response.ok) throw new Error("Pairing failed. Create a new code and try again.");
      const data = await response.json();
      if (typeof data.token !== "string" || !data.token || data.token.length > 4096) throw new Error("Invalid pairing response.");
      const config = { server: origin, token: data.token, userId: data.device?.userId, deviceId: data.device?.id, name: os.hostname(),
        dataDir: path.join(app.getPath("userData"), "runner-data", ...(data.device?.userId ? [connectionKey(origin, data.device.userId)] : [])), workspacesDir: workspacesDir() };
      saveRunnerConfig(config);
      autoConnection.approveManual(config);
      settings.runnerEnabled = true;
      saveSettings();
      startRunner();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally { pairing = false; if (quitting) app.quit(); }
  });
}

async function checkUpdates() {
  if (!updater) { report("Updates are not configured for this build. Obtain a new installer from your administrator."); return; }
  if (updateReady) { await installUpdate(); return; }
  if (updateBusy) return;
  updateBusy = true;
  try { report("Checking for updates…"); await updater.checkForUpdates(); }
  catch { report("Could not check for updates. Try again when you are online."); }
  finally { updateBusy = false; }
}

async function installUpdate() {
  if (runnerProcess || pairing) { report("Update downloaded. Pause the runner and wait for it to stop, then check for updates again to install safely."); return; }
  const result = await dialog.showMessageBox({ message: "Update ready to install", detail: "Save any unsent drafts first. The app will restart.", buttons: ["Later", "Restart and install"], defaultId: 0, cancelId: 0 });
  if (result.response === 1 && !runnerProcess && !pairing) updater.quitAndInstall();
}

function configureUpdates() {
  if (!app.isPackaged || !release.updateUrl) return;
  const { autoUpdater } = require("electron-updater");
  updater = autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.on("error", () => report("Update failed. Your current version is unchanged; try again later."));
  updater.on("update-not-available", () => report("You are up to date."));
  updater.on("update-available", async info => {
    const result = await dialog.showMessageBox({ message: "Update " + info.version + " is available", buttons: ["Later", "Download"], defaultId: 0, cancelId: 0 });
    if (result.response === 1) void updater.downloadUpdate().catch(() => report("Update download failed. Try again later."));
  });
  updater.on("update-downloaded", () => { updateReady = true; void installUpdate(); });
  updateTimer = setInterval(() => void checkUpdates(), 6 * 60 * 60 * 1000);
  updateTimer.unref();
  void checkUpdates();
}

function startDevelopmentServer() {
  if (app.isPackaged || process.env.DESKTOP_SPAWN_SERVER === "0" || !process.argv.includes("--local-server")) return;
  if (process.env.APP_URL) return;
  settings.url = "http://127.0.0.1:3000";
  const entry = require.resolve("next/dist/bin/next", { paths: [path.resolve(__dirname, "../..")] });
  const production = process.env.NODE_ENV === "production";
  serverProcess = spawn(process.execPath, [entry, production ? "start" : "dev", "--hostname", "127.0.0.1", ...(production ? ["--keepAliveTimeout", "70000"] : [])], {
    cwd: path.resolve(__dirname, "../.."), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit",
  });
  serverProcess.on("error", () => { report("Could not start the development server."); showSetup(); });
  serverProcess.on("exit", () => {
    serverProcess = null;
    if (!quitting) { report("The development server stopped. Restart it and reopen the workspace."); showSetup(); }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWorkspace);
  app.whenReady().then(() => {
    app.setAppUserModelId("ai.multiplayer.desktop");
    registerIpc();
    connectionTimer = setInterval(() => { void autoConnection.sync(); }, 15000);
    connectionTimer.unref();
    const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 22, height: 22 });
    tray = new Tray(icon);
    setRunnerState(paired() ? "paused" : "not paired");
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Multicode AI", submenu: [{ role: "about" }, { label: "Desktop settings", accelerator: "CmdOrCtrl+,", click: showSetup }, { label: "Check for updates", click: () => void checkUpdates() }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" },
      { label: "View", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
      { role: "windowMenu" },
    ]));
    startDevelopmentServer();
    // A configured build is the workspace: open it straight away so the app shows the same
    // sign-in and workspace pages as the browser. Setup is only for builds with no address.
    if (settings.url) void connect();
    else showSetup();
    configureUpdates();
    app.on("activate", showWorkspace);
  }).catch(error => { dialog.showErrorBox("Desktop startup failed", error.message); app.exit(1); });
}

app.on("window-all-closed", () => { if (!runnerProcess && process.platform !== "darwin") app.quit(); });
app.on("before-quit", event => {
  quitting = true;
  connecting?.abort();
  if (updateTimer) clearInterval(updateTimer);
  if (connectionTimer) clearInterval(connectionTimer);
  if (pairing) {
    event.preventDefault();
    report("Finishing device pairing before quitting…");
    return;
  }
  if (runnerProcess) {
    event.preventDefault();
    stopRunner();
    showSetup();
    return;
  }
  serverProcess?.kill();
  tray?.destroy();
});
