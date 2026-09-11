const { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain, dialog, utilityProcess } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const { workspaceUrl, sameOrigin, externalUrl, waitForServer, runnerEnvironment } = require("./policy");

app.setName("Multiplayer AI");
const setupUrl = pathToFileURL(path.join(__dirname, "setup.html")).href;
const settingsPath = path.join(app.getPath("userData"), "desktop.json");
const runnerPath = path.join(app.getPath("userData"), "runner.json");
const release = JSON.parse(fs.readFileSync(path.join(__dirname, "release.json"), "utf8"));
let settings = { url: "", runnerEnabled: false };
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

try {
  const saved = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  settings = { url: workspaceUrl(saved.url, !app.isPackaged), runnerEnabled: saved.runnerEnabled === true };
} catch {
  try { settings.url = workspaceUrl(release.workspaceUrl, !app.isPackaged); } catch {}
}
if (!app.isPackaged && process.env.APP_URL) {
  try { settings.url = workspaceUrl(process.env.APP_URL, true); }
  catch { message = "APP_URL is invalid. Enter a valid workspace address."; settings.url = ""; }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporary = settingsPath + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(settings), { mode: 0o600 });
  fs.renameSync(temporary, settingsPath);
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
  const allowed = url => local ? url === setupUrl : sameOrigin(url, settings.url);
  contents.setWindowOpenHandler(({ url }) => {
    if (!local && externalUrl(url)) void openExternal(url);
    return { action: "deny" };
  });
  for (const eventName of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    contents.on(eventName, (event, url) => {
      const destination = typeof url === "string" ? url : event.url;
      if (!allowed(destination)) event.preventDefault();
    });
  }
  contents.on("will-attach-webview", event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  contents.session.on("will-download", event => event.preventDefault());
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
    title: "Multiplayer AI — Desktop settings", backgroundColor: "#151515",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "setup-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, partition: "desktop-settings" },
  });
  security(setupWindow, true);
  void setupWindow.loadURL(setupUrl);
  setupWindow.on("closed", () => { setupWindow = null; });
}

function createWorkspace() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  mainWindow = new BrowserWindow({
    width: 1440, height: 940, minWidth: 700, minHeight: 500,
    show: false, title: "Multiplayer AI", backgroundColor: "#151515",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false },
  });
  security(mainWindow);
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
  try {
    await waitForServer(settings.url, { timeoutMs: serverProcess ? 90000 : 15000, signal: controller.signal });
    if (controller.signal.aborted || quitting) return;
    const window = createWorkspace();
    await window.loadURL(settings.url);
    if (controller.signal.aborted || window.isDestroyed() || quitting) return;
    window.show();
    window.focus();
    report("Connected to " + settings.url);
    setupWindow?.hide();
    startRunner();
  } catch (error) {
    if (!controller.signal.aborted && !quitting) {
      report(error.message);
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
  tray?.setToolTip("Multiplayer AI — Runner: " + runnerState);
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: "Runner: " + runnerState, enabled: false },
    { label: "Open workspace", click: showWorkspace },
    { label: "Desktop settings", click: showSetup },
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
  try {
    const entry = app.isPackaged ? path.join(process.resourcesPath, "app.asar.unpacked", "runner.cjs") : path.join(__dirname, "runner.cjs");
    const child = utilityProcess.fork(entry, ["start"], {
      cwd: app.getPath("userData"), env: runnerEnvironment(process.env, runnerPath), stdio: "pipe", serviceName: "Multiplayer AI Runner",
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
        settings.runnerEnabled = false;
        saveSettings();
        report("Runner stopped. Check Git, your AI CLI, and device pairing, then resume.");
      }
      if (quitting) app.quit();
    });
  } catch {
    settings.runnerEnabled = false;
    saveSettings();
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

function registerIpc() {
  setupHandler("desktop:status", () => ({ url: settings.url, enabled: settings.runnerEnabled, paired: paired(), runner: runnerState, message, version: app.getVersion() }));
  setupHandler("desktop:connect", async value => {
    if (runnerProcess || pairing) throw new Error("Pause the runner and wait for it to stop before changing workspaces.");
    const url = workspaceUrl(value, !app.isPackaged);
    if (url !== settings.url) {
      settings.runnerEnabled = false;
      mainWindow?.destroy();
      mainWindow = null;
    }
    settings.url = url;
    saveSettings();
    setRunnerState(paired() ? "paused" : "not paired");
    await connect();
  });
  setupHandler("desktop:retry", connect);
  setupHandler("desktop:toggle-runner", toggleRunner);
  setupHandler("desktop:updates", checkUpdates);
  ipcMain.handle("desktop:pair", async (event, code) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !sameOrigin(event.senderFrame.url, settings.url)) throw new Error("Not allowed.");
    if (pairing || runnerProcess || quitting) return { ok: false, error: "Pause the runner and wait for it to stop before pairing again." };
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
      const temporary = runnerPath + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify({ server: origin, token: data.token, name: os.hostname(), dataDir: path.join(app.getPath("userData"), "runner-data") }), { mode: 0o600 });
      fs.renameSync(temporary, runnerPath);
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
  serverProcess = spawn(process.execPath, [entry, process.env.NODE_ENV === "production" ? "start" : "dev", "--hostname", "127.0.0.1"], {
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
    const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 22, height: 22 });
    tray = new Tray(icon);
    setRunnerState(paired() ? "paused" : "not paired");
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "Multiplayer AI", submenu: [{ role: "about" }, { label: "Desktop settings", accelerator: "CmdOrCtrl+,", click: showSetup }, { label: "Check for updates", click: () => void checkUpdates() }, { type: "separator" }, { role: "quit" }] },
      { role: "editMenu" },
      { label: "View", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "togglefullscreen" }] },
      { role: "windowMenu" },
    ]));
    startDevelopmentServer();
    showSetup();
    if (settings.url) void connect();
    configureUpdates();
    app.on("activate", showWorkspace);
  }).catch(error => { dialog.showErrorBox("Desktop startup failed", error.message); app.exit(1); });
}

app.on("window-all-closed", () => { if (!runnerProcess && process.platform !== "darwin") app.quit(); });
app.on("before-quit", event => {
  quitting = true;
  connecting?.abort();
  if (updateTimer) clearInterval(updateTimer);
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
