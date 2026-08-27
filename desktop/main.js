const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
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

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
