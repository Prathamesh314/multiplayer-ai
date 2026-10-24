/**
 * Updates from the website's own release: the one `/install/latest` names and
 * the install commands use. The free installers carry no signature, which
 * Electron's updater needs, so the app does what the install commands do:
 * download this computer's installer, check it against the published SHA-256
 * checksums (refusing anything that does not match), and swap it in when the
 * person chooses Restart. Nothing is installed without that choice.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync, spawn } = require("node:child_process");

/** The installer in a release for this computer, as named in SHA256SUMS.txt. */
function assetPattern(platform, arch, linuxKind) {
  if (platform === "darwin") return new RegExp(`^Multicode-AI-[^ /]+-mac-${arch === "arm64" ? "arm64" : "x64"}(-preview)?\\.dmg$`);
  if (platform === "win32") return /^Multicode-AI-[^ /]+-win-x64(-preview)?\.exe$/;
  if (platform === "linux") return linuxKind === "deb" ? /^Multicode-AI-[^ /]+-linux-(amd64|x64)(-preview)?\.deb$/ : /^Multicode-AI-[^ /]+-linux-x86_64(-preview)?\.AppImage$/;
  return null;
}

/** "<sha256>  <file>" lines; the last match wins, as in the install scripts. */
function pickAsset(sums, pattern) {
  let found = null;
  for (const line of String(sums).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match && pattern.test(match[2])) found = { hash: match[1], name: match[2] };
  }
  return found;
}

/** The release folder `/install/latest` names, which is the build's id. Only on the workspace's own site. */
function latestRelease(text, origin) {
  const base = new URL(String(text).trim());
  const site = new URL(origin);
  if (base.origin !== site.origin || base.username || base.password || base.search || base.hash) throw new Error("The release is not on this workspace's site.");
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Updates need HTTPS.");
  const id = base.pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(id)) throw new Error("Unexpected release name.");
  return { id, base: base.href.endsWith("/") ? base.href : base.href + "/" };
}

/** preview-<commit>-<run> → the commit, for "See changes". */
function commitOf(id) {
  return /-([0-9a-f]{7,40})-\d+$/.exec(id)?.[1] ?? null;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * `build`/`commit`: this app's own release (release.json). Without a build id
 * (development, test builds) there is nothing to compare with, so no checks.
 */
function createSiteUpdater({ origin, build, commit, sourceUrl, platform, arch, linuxKind, dir, fetch, notify }) {
  let state = { status: "idle" };
  let running = null;
  const set = (next) => { state = next; notify?.(state); };

  async function text(url) {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.text();
  }

  async function download(url, file, expected) {
    const part = file + ".part";
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    const hash = createHash("sha256");
    const out = fs.createWriteStream(part, { mode: 0o600 });
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    if (hash.digest("hex") !== expected) {
      fs.rmSync(part, { force: true });
      throw new Error("The download does not match its published checksum; nothing was installed.");
    }
    fs.renameSync(part, file);
  }

  async function run() {
    const site = origin();
    const pattern = assetPattern(platform, arch, linuxKind);
    if (!site || !build || !pattern) return state;
    const latest = latestRelease(await text(new URL("/install/latest", site).href), site);
    if (latest.id === build) {
      if (state.status !== "idle") set({ status: "idle" });
      return state;
    }
    if (state.status === "ready" && state.build === latest.id) return state;
    const asset = pickAsset(await text(latest.base + "SHA256SUMS.txt"), pattern);
    if (!asset) return state;
    const folder = path.join(dir, latest.id);
    const file = path.join(folder, asset.name);
    fs.mkdirSync(folder, { recursive: true });
    if (!(fs.existsSync(file) && await sha256(file) === asset.hash)) {
      set({ status: "downloading", build: latest.id });
      await download(latest.base + asset.name, file, asset.hash);
    }
    // Only the newest download is kept.
    for (const name of fs.readdirSync(dir)) if (name !== latest.id) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    const next = commitOf(latest.id);
    set({
      status: "ready",
      build: latest.id,
      file,
      changesUrl: sourceUrl && commit && next ? `${sourceUrl}/compare/${commit}...${next}` : sourceUrl ? `${sourceUrl}/commits/main` : null,
    });
    return state;
  }

  return {
    state: () => state,
    /** One check at a time; failures leave the app as it is and are tried again later. */
    check() {
      running ??= run().catch((error) => {
        if (state.status === "downloading") set({ status: "idle" });
        return { ...state, error: error.message };
      }).finally(() => { running = null; });
      return running;
    },
  };
}

/**
 * Replaces this app with the downloaded installer once the app has quit, then
 * opens the new version. Returns false when this install cannot be replaced
 * in place (the caller then opens the download page instead).
 */
function installUpdate({ file, platform, exePath, pid, env = process.env }) {
  const detached = (command, args, extraEnv = {}) =>
    spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true, env: { ...env, ...extraEnv } }).unref();

  if (platform === "darwin") {
    const bundle = path.resolve(exePath, "../../..");
    if (!bundle.endsWith(".app") || bundle.includes("/AppTranslocation/")) return false;
    const parent = path.dirname(bundle);
    try { fs.accessSync(parent, fs.constants.W_OK); } catch { return false; }
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), "multicode-update-"));
    const next = path.join(parent, "." + path.basename(bundle, ".app") + ".update.app");
    execFileSync("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-quiet", "-mountpoint", mount, file]);
    try {
      const app = fs.readdirSync(mount).find((name) => name.endsWith(".app"));
      if (!app) throw new Error("The disk image has no app in it.");
      fs.rmSync(next, { recursive: true, force: true });
      execFileSync("ditto", [path.join(mount, app), next]);
    } finally {
      try { execFileSync("hdiutil", ["detach", mount, "-quiet"]); } catch { /* detached when the computer restarts */ }
    }
    // Paths go in as arguments, never into the script's text.
    detached("/bin/sh", ["-c", 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; rm -rf "$2" && mv "$3" "$2" && xattr -dr com.apple.quarantine "$2" 2>/dev/null; open "$2"', "sh", String(pid), bundle, next]);
    return true;
  }

  if (platform === "win32") {
    // Installed for this user (under %LOCALAPPDATA%) or for everyone; the update goes to the same place.
    const installDir = path.dirname(exePath);
    const local = env.LOCALAPPDATA && installDir.toLowerCase().startsWith(env.LOCALAPPDATA.toLowerCase());
    detached("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
      "Wait-Process -Id $env:MC_PID -ErrorAction SilentlyContinue; " +
      "$arguments = @('/S', $env:MC_SCOPE, '--force-run', ('/D=' + $env:MC_DIR)); " +
      "if ($env:MC_SCOPE -eq '/allusers') { Start-Process -FilePath $env:MC_INSTALLER -ArgumentList $arguments -Verb RunAs } else { Start-Process -FilePath $env:MC_INSTALLER -ArgumentList $arguments }"],
      { MC_PID: String(pid), MC_INSTALLER: file, MC_DIR: installDir, MC_SCOPE: local ? "/currentuser" : "/allusers" });
    return true;
  }

  if (platform === "linux") {
    if (file.endsWith(".AppImage")) {
      const current = env.APPIMAGE;
      if (!current) return false;
      try { fs.accessSync(path.dirname(current), fs.constants.W_OK); } catch { return false; }
      const next = current + ".update";
      fs.copyFileSync(file, next);
      fs.chmodSync(next, 0o755);
      detached("/bin/sh", ["-c", 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; mv -f "$3" "$2" && nohup "$2" >/dev/null 2>&1 &', "sh", String(pid), current, next]);
      return true;
    }
    // The .deb needs administrator rights: pkexec asks for the password in a window.
    if (!fs.existsSync("/usr/bin/pkexec")) return false;
    detached("/bin/sh", ["-c", 'while kill -0 "$1" 2>/dev/null; do sleep 0.3; done; pkexec dpkg -i "$2"; nohup "$3" >/dev/null 2>&1 &', "sh", String(pid), file, exePath]);
    return true;
  }
  return false;
}

module.exports = { assetPattern, pickAsset, latestRelease, commitOf, createSiteUpdater, installUpdate };
