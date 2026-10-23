const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const os = require("node:os");

function workspaceUrl(value, allowLocal = false) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Enter only the workspace origin, without a path, credentials, or query.");
  }
  if (url.protocol !== "https:" && !(allowLocal && local && url.protocol === "http:")) {
    throw new Error("Use an HTTPS workspace address. HTTP is allowed only for local development.");
  }
  return url.origin;
}

function sameOrigin(value, origin) {
  try {
    const url = new URL(value);
    return Boolean(origin) && ["https:", "http:"].includes(url.protocol) &&
      !url.username && !url.password && url.origin === origin;
  } catch {
    return false;
  }
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Where a link goes in the desktop app, which is the workspace and nothing else:
 * - "app": workspace pages, opened in the app window;
 * - "home": the marketing homepage (with any #section), never shown in the app:
 *   in the window it means "go to the workspace", from a new-tab link (such as
 *   "Download the latest app") it opens in the browser;
 * - "browser": this site's documentation, read in the browser;
 * - "external": other http(s)/mailto links, opened in the browser after asking;
 * - "blocked": anything else.
 */
function linkTarget(value, origin) {
  if (sameOrigin(value, origin)) {
    const { pathname } = new URL(value);
    if (pathname === "/" || pathname === "") return "home";
    if (pathname === "/docs" || pathname.startsWith("/docs/")) return "browser";
    return "app";
  }
  return externalUrl(value) ? "external" : "blocked";
}

/**
 * Frames inside a workspace page: its own, plus Cloudflare Turnstile, the bot
 * check Clerk shows when creating an account. Nothing else loads in a frame.
 */
function frameAllowed(value, origin) {
  if (sameOrigin(value, origin)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "challenges.cloudflare.com" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Downloads the workspace starts itself (exports, files); never other origins. */
function downloadAllowed(value, origin) {
  if (sameOrigin(value, origin)) return true;
  // blob: URLs carry their creator's origin, e.g. blob:https://multicode.in/uuid (an export).
  return Boolean(origin) && typeof value === "string" && value.startsWith("blob:" + origin + "/");
}

async function waitForServer(value, { timeoutMs = 60000, intervalMs = 500, signal } = {}) {
  const url = new URL(value);
  const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!transport) throw new Error("Unsupported workspace protocol.");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const ready = await new Promise((resolve) => {
      const request = transport.get(url, { signal }, (response) => {
        response.resume();
        resolve(response.statusCode >= 200 && response.statusCode < 400);
      });
      const timer = setTimeout(() => request.destroy(), Math.min(3000, Math.max(1, deadline - Date.now())));
      request.on("error", () => resolve(false));
      request.on("close", () => clearTimeout(timer));
    });
    if (ready) return;
    signal?.throwIfAborted();
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error("The workspace did not respond. Check the address, connection, and server status, then retry.");
}

function runnerEnvironment(env, configPath) {
  const result = {};
  for (const key of ["HOME", "USERPROFILE", "PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "SHELL", "LANG", "LC_ALL", "APPDATA", "LOCALAPPDATA", "PATHEXT", "ProgramFiles", "XDG_CONFIG_HOME", "SSH_AUTH_SOCK", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    if (env[key]) result[key] = env[key];
  }
  if (process.platform !== "win32") {
    result.PATH = [...new Set([...(result.PATH || "/usr/bin:/bin").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".npm-global", "bin")])].join(path.delimiter);
  }
  result.RUNNER_CONFIG = configPath;
  return result;
}

module.exports = { workspaceUrl, sameOrigin, externalUrl, linkTarget, frameAllowed, downloadAllowed, waitForServer, runnerEnvironment };
