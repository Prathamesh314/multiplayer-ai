const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

// Where the Next.js server lives. Override with APP_URL to point at an
// already-running server (e.g. a remote/staging instance).
const APP_URL = process.env.APP_URL || "http://localhost:3000";

// Set DESKTOP_SPAWN_SERVER=0 to attach to a server you started yourself
// (e.g. `npm run dev` in another terminal) instead of having Electron boot one.
const SHOULD_SPAWN = process.env.DESKTOP_SPAWN_SERVER !== "0";

// Use `next start` (prod, requires a build) when NODE_ENV=production, else `next dev`.
// NB: the prod script is `next:start`, not `start` — `start` launches Electron itself.
const SERVER_SCRIPT = process.env.NODE_ENV === "production" ? "next:start" : "dev";

let serverProcess = null;
let mainWindow = null;

// ---------------------------------------------------------------------------
// The local runner: agents execute on this machine (docs/local-execution.md).
//
// When this computer is paired (the runner config exists), the desktop app
// supervises the runner daemon and shows its state in the tray. Pause from
// the tray stops claiming new runs; runs the machine owner didn't start never
// arrive here at all — jobs are addressed to their author's own devices.
// Disable entirely with DESKTOP_RUNNER=0.
// ---------------------------------------------------------------------------

const RUNNER_ENABLED = process.env.DESKTOP_RUNNER !== "0";

let runnerProcess = null;
let tray = null;
// "off" (unpaired/disabled) · "paused" · "online" · "running <runId>"
let runnerState = "off";

function runnerConfigPath() {
  return (
    process.env.RUNNER_CONFIG || path.join(os.homedir(), ".config", "multiplayer-ai", "runner.json")
  );
}

function runnerPaired() {
  try {
    return fs.existsSync(runnerConfigPath());
  } catch {
    return false;
  }
}

function setRunnerState(state) {
  runnerState = state;
  updateTray();
}

function startRunner() {
  if (!RUNNER_ENABLED || runnerProcess || !runnerPaired()) return;
  const repoRoot = path.join(__dirname, "..");
  runnerProcess = spawn("npm", ["run", "runner", "--silent", "--", "start"], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  setRunnerState("online");

  // The runner narrates its lifecycle one line at a time; the tray mirrors it.
  let buffer = "";
  runnerProcess.stdout.setEncoding("utf8");
  runnerProcess.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.includes(": claimed")) setRunnerState("running");
      else if (line.includes(": completed") || line.includes(": failed")) setRunnerState("online");
      else if (line.includes("online as")) setRunnerState("online");
      console.log(line);
    }
  });
  runnerProcess.stderr.setEncoding("utf8");
  runnerProcess.stderr.on("data", (chunk) => console.error(chunk.trimEnd()));

  runnerProcess.on("exit", (code) => {
    runnerProcess = null;
    // A revoked token exits deliberately; anything else gets one retry lane
    // via the tray (Resume). Never crash-loop in the background.
    setRunnerState("paused");
    if (code !== 0 && !app.isQuitting) {
      console.error(`runner exited with code ${code}`);
    }
  });
}

function stopRunner() {
  if (!runnerProcess) return;
  runnerProcess.kill();
  runnerProcess = null;
  setRunnerState("paused");
}

function trayLabel() {
  if (runnerState === "running") return "Runner: executing a run";
  if (runnerState === "online") return "Runner: online, waiting for runs";
  if (runnerState === "paused") return "Runner: paused";
  return runnerPaired() ? "Runner: off" : "Runner: not paired";
}

function updateTray() {
  if (!tray) return;
  // macOS renders the state as a character next to the (empty) icon; other
  // platforms rely on the tooltip + menu until a real icon set ships.
  if (process.platform === "darwin") {
    tray.setTitle(runnerState === "running" ? "◆" : runnerState === "online" ? "●" : "○");
  }
  tray.setToolTip(`Multiplayer AI — ${trayLabel()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayLabel(), enabled: false },
      { type: "separator" },
      runnerProcess
        ? { label: "Pause runner", click: () => stopRunner() }
        : {
            label: runnerPaired() ? "Resume runner" : "Pair this computer…",
            click: () => {
              if (runnerPaired()) startRunner();
              else showWindow(); // pairing lives in the app: profile → Your computers
            },
          },
      { type: "separator" },
      { label: "Open Multiplayer AI", click: () => showWindow() },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

function createTray() {
  if (!RUNNER_ENABLED) return;
  // An empty image + a text title is a dependency-free macOS status item; a
  // proper icon set arrives with packaging.
  tray = new Tray(nativeImage.createEmpty());
  updateTray();
}

function waitForServer(url, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Server at ${url} did not respond within ${timeoutMs}ms`));
        } else {
          setTimeout(ping, intervalMs);
        }
      });
    };
    ping();
  });
}

function startServer() {
  if (!SHOULD_SPAWN) return;
  const repoRoot = path.join(__dirname, "..");
  // Run the same script the README documents so behaviour matches the browser.
  serverProcess = spawn("npm", ["run", SERVER_SCRIPT], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  serverProcess.on("exit", (code) => {
    // If the server dies, tear the app down too — a webview with no backend is useless.
    if (code !== 0 && !app.isQuitting) {
      console.error(`Next.js server exited with code ${code}`);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Multiplayer AI",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open target=_blank / external links in the user's real browser, not the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(APP_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.loadURL(APP_URL);

  if (process.env.DESKTOP_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  startServer();
  try {
    await waitForServer(APP_URL);
  } catch (err) {
    console.error(err.message);
  }
  createWindow();
  createTray();
  startRunner();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (runnerProcess) {
    runnerProcess.kill();
    runnerProcess = null;
  }
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
