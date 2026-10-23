// A real npm-installed CLI, started the way the app starts Claude Code and Codex.
// On Windows npm installs a `.cmd` launcher that Node refuses to start; this
// checks the app still starts it, with no shell, and that text that means
// something to cmd.exe reaches the CLI as plain text. Runs on every desktop CI OS.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCommand } from "../app/lib/ai/command.ts";

const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";

function run(file, args, env) {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 30_000, windowsHide: true }, (error, stdout) => resolve({ error, stdout }));
  });
}

test("an npm-installed CLI starts, and its arguments are never read by a shell", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "mc-agent-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const prefix = path.join(root, "global");
  await mkdir(path.join(source, "bin"), { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "multicode-probe-cli", version: "1.2.3", bin: { "multicode-probe": "bin/cli.js" } }));
  await writeFile(path.join(source, "bin", "cli.js"), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  // `npm i -g`, as people install the Codex CLI, into a folder of our own.
  // (npm.cmd is itself a launcher, so this one call goes through cmd.exe; it is test setup.)
  const tarball = execFileSync(npm, ["pack", "--silent", "--pack-destination", root], { cwd: source, encoding: "utf8", shell: windows }).trim().split(/\r?\n/).pop();
  execFileSync(npm, ["install", "-g", "--prefix", prefix, path.join(root, tarball)], { stdio: "inherit", shell: windows });

  const bin = windows ? prefix : path.join(prefix, "bin");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ""}` };
  delete env.Path;

  if (windows) {
    // What used to happen: the tool reads as not installed.
    const before = await run("multicode-probe", ["--version"], env);
    assert.ok(before.error, "Node is not expected to start an npm .cmd launcher by name");
  }

  const command = resolveCommand("multicode-probe", { env });
  assert.ok(command, "the installed CLI is found");
  const tricky = ["exec", "fix the bug & echo INJECTED | more", "100%PATH%", "\"quoted\" ^caret", "--json"];
  const result = await run(command.file, [...command.args, ...tricky], env);
  assert.ifError(result.error);
  assert.deepEqual(JSON.parse(result.stdout), tricky);
});
