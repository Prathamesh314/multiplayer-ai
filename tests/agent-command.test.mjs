// Starting an AI tool's CLI on Windows without a shell: npm installs CLIs as
// `.cmd` launchers, which Node will not start, so the launcher's own target is
// started instead. Without this a Windows computer reports no AI tools at all.
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCommand } from "../app/lib/ai/command.ts";
import { agentEnv } from "../app/lib/ai/env.ts";
import { pickOrg } from "../app/lib/org/last-org.ts";

const npm = "C:\\Users\\ana\\AppData\\Roaming\\npm";
const nodeDir = "C:\\Program Files\\nodejs";
// What npm 10's cmd-shim writes for `npm i -g @openai/codex`.
const codexShim = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

function windows(files, env = {}) {
  const lower = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]));
  return {
    platform: "win32",
    env: { PATH: `C:\\Windows\\system32;${nodeDir};${npm}`, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS", ...env },
    exists: (file) => lower.has(file.toLowerCase()),
    read: (file) => {
      const text = lower.get(file.toLowerCase());
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
  };
}

test("macOS and Linux start the CLI by name", () => {
  assert.deepEqual(resolveCommand("codex", { platform: "darwin" }), { file: "codex", args: [] });
  assert.deepEqual(resolveCommand("claude", { platform: "linux" }), { file: "claude", args: [] });
});

test("an npm-installed CLI runs its JavaScript entry under Node, with no shell", () => {
  const options = windows({
    [`${npm}\\codex.cmd`]: codexShim,
    [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`]: "",
    [`${nodeDir}\\node.exe`]: "",
  });
  assert.deepEqual(resolveCommand("codex", options), {
    file: `${nodeDir}\\node.exe`,
    args: [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`],
  });
});

test("a node.exe beside the launcher is preferred, as the launcher does", () => {
  const options = windows({
    [`${npm}\\codex.cmd`]: codexShim,
    [`${npm}\\node.exe`]: "",
    [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`]: "",
    [`${nodeDir}\\node.exe`]: "",
  });
  assert.equal(resolveCommand("codex", options).file, `${npm}\\node.exe`);
});

test("a native .exe on PATH runs directly", () => {
  const exe = "C:\\Users\\ana\\.local\\bin\\claude.exe";
  const options = windows({ [exe]: "" }, { PATH: "C:\\Users\\ana\\.local\\bin" });
  assert.deepEqual(resolveCommand("claude", options), { file: exe, args: [] });
});

test("an explicitly selected npm launcher resolves outside PATH", () => {
  const options = windows({
    [`${npm}\\codex.cmd`]: codexShim,
    [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`]: "",
    [`${nodeDir}\\node.exe`]: "",
  }, { PATH: nodeDir });
  assert.deepEqual(resolveCommand(`${npm}\\codex.cmd`, options), {
    file: `${nodeDir}\\node.exe`, args: [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`],
  });
});

test("Git installed after the runner started is found in its Windows installation directory", () => {
  const git = "C:\\Program Files\\Git\\cmd\\git.exe";
  assert.deepEqual(resolveCommand("git", windows({ [git]: "" }, {
    PATH: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files",
  })), { file: git, args: [] });
  const userGit = "C:\\Users\\ana\\AppData\\Local\\Programs\\Git\\cmd\\git.exe";
  assert.deepEqual(resolveCommand("git", windows({ [userGit]: "" }, {
    PATH: "", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local",
  })), { file: userGit, args: [] });
});

test("agent startup preserves Windows Git Bash and login configuration", () => {
  const values = {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_GIT_BASH_PATH: "D:\\Developer Tools\\Git\\bin\\bash.exe",
    CLAUDE_CODE_OAUTH_TOKEN: "test-only-login",
    CLAUDE_CODE_USE_BEDROCK: "1",
  };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const env = agentEnv("claude");
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    for (const key of ["CLAUDE_CODE_GIT_BASH_PATH", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]) {
      assert.equal(env[key], values[key]);
    }
    assert.equal(process.env.CLAUDECODE, "1", "the parent environment is unchanged");
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("a launcher that points at an .exe runs that .exe", () => {
  const target = `${npm}\\node_modules\\tool\\bin\\tool.exe`;
  const options = windows({ [`${npm}\\tool.cmd`]: '@"%~dp0\\node_modules\\tool\\bin\\tool.exe"   %*\r\n', [target]: "" });
  assert.deepEqual(resolveCommand("tool", options), { file: target, args: [] });
});

test("a CLI installed after the app started is found in npm's folder", () => {
  // PATH as it was when the app started: no npm folder yet.
  const options = windows({
    [`${npm}\\codex.cmd`]: codexShim,
    [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`]: "",
    [`${nodeDir}\\node.exe`]: "",
  }, { PATH: "C:\\Windows\\system32", APPDATA: "C:\\Users\\ana\\AppData\\Roaming", ProgramFiles: "C:\\Program Files" });
  assert.equal(resolveCommand("codex", options).file, `${nodeDir}\\node.exe`);
});

test("nothing runnable means no command, never a shell", () => {
  assert.equal(resolveCommand("codex", windows({})), null);
  // An unknown launcher format is not guessed at.
  assert.equal(resolveCommand("codex", windows({ [`${npm}\\codex.cmd`]: "@echo off\r\ncodex-real %*\r\n" })), null);
  // A launcher whose target is missing.
  assert.equal(resolveCommand("codex", windows({ [`${npm}\\codex.cmd`]: codexShim, [`${nodeDir}\\node.exe`]: "" })), null);
  // No Node to run it with.
  assert.equal(resolveCommand("codex", windows({
    [`${npm}\\codex.cmd`]: codexShim,
    [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`]: "",
  })), null);
});

test("a refresh reopens the organisation you were in", () => {
  const orgs = [{ id: "o1", slug: "first" }, { id: "o2", slug: "second" }, { id: "o3", slug: "third" }];
  const store = new Map();
  globalThis.window = { localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } };
  try {
    assert.equal(pickOrg(orgs, null, null), "first");
    store.set("multicode:last-org", JSON.stringify({ id: "o2", slug: "second" }));
    assert.equal(pickOrg(orgs, null, null), "second");
    // Renamed since: the id still finds it.
    store.set("multicode:last-org", JSON.stringify({ id: "o3", slug: "old-name" }));
    assert.equal(pickOrg(orgs, null, null), "third");
    // The address wins, then the org already open.
    assert.equal(pickOrg(orgs, "first", "second"), "first");
    assert.equal(pickOrg(orgs, "missing", "second"), "second");
    // Left an org: fall back to the first.
    store.set("multicode:last-org", JSON.stringify({ id: "gone", slug: "gone" }));
    assert.equal(pickOrg(orgs, null, null), "first");
    assert.equal(pickOrg([], null, null), null);
  } finally {
    delete globalThis.window;
  }
});

test("a slow or silent sign-in check never hides an installed AI tool", async (t) => {
  const { authStatus } = await import("../app/lib/ai/detect.ts");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "mc-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = async (name, source) => { const file = join(dir, name); await writeFile(file, source); return file; };
  const parseStatus = (stdout) => { const data = JSON.parse(stdout); return { loggedIn: !!data.loggedIn, method: null, email: null, plan: null }; };
  const spec = (script) => ({ bin: process.execPath, auth: { statusArgs: [script], loginArgs: [], logoutArgs: [], parseStatus } });
  // Signed out: the CLI says so (on a nonzero exit, as Claude Code does).
  assert.deepEqual(await authStatus(spec(await cli("out.js", "console.log(JSON.stringify({ loggedIn: false })); process.exit(1);"))), { loggedIn: false, method: null, email: null, plan: null });
  // Signed in.
  assert.equal((await authStatus(spec(await cli("in.js", "console.log(JSON.stringify({ loggedIn: true }));"))))?.loggedIn, true);
  // The check failed without saying anything: unknown, so the tool stays offered.
  assert.equal(await authStatus(spec(await cli("silent.js", "process.exit(3);"))), null);
});

test("Windows command lines over 32,767 characters are refused with a reason, not a spawn error", async () => {
  const { windowsCommandLineLength } = await import("../runner/execute.ts");
  assert.equal(windowsCommandLineLength("gemini.exe", ["-p", "hello"]), "gemini.exe".length + 1 + 3 + 6);
  assert.equal(windowsCommandLineLength("a", ['say "hi"']), 1 + 1 + 'say "hi"'.length + 2 + 2 + 1, "quotes are escaped and the argument quoted");
  assert.ok(windowsCommandLineLength("node.exe", ["gemini.js", "-p", "x".repeat(20_000)]) < 32_767, "a full-size prompt fits");
  assert.ok(windowsCommandLineLength("node.exe", ["gemini.js", "-p", "x".repeat(40_000)]) > 32_767, "a prompt with long history does not");
});

test("the runner reads Git's version on this computer (AI tasks need Git)", async () => {
  const { gitVersion } = await import("../app/lib/git/command.ts");
  assert.match(await gitVersion(), /^\d+\.\d+/);
});
