import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { listLocalWorkspaces, locationPath } from "../runner/workspace-layout.ts";
import { defaultWorkspacesDir, resolveWorkspacesDir, resolveMaxParallel, resolveCopyIgnoredFiles } from "../runner/config.ts";
import { ActivityOutbox } from "../runner/activity-outbox.ts";
import { RunnerGit } from "../runner/git.ts";
import { checkpointOverwritesIgnored } from "../runner/checkpoints.ts";

const exec = promisify(execFile);
const author = { name: "Workspace test", email: "workspace@example.test" };
const git = async (cwd, ...args) => (await exec("git", ["-c", "commit.gpgsign=false", "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, ...args], { cwd })).stdout.trim();
const job = (baseSha, extra = {}) => ({ userId: "alice", sessionId: "room-a", repoId: null, projectId: "project-a", projectRepositoryId: "repository-a", turnId: randomUUID(), baseSha, ...extra });
const common = work => git(work, "rev-parse", "--path-format=absolute", "--git-common-dir");

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner-workspaces-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  await mkdir(seed);
  await git(seed, "init", "-b", "main");
  await writeFile(join(seed, "code.txt"), "initial\n");
  await writeFile(join(seed, ".gitignore"), ".env.local\nnode_modules/\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "-m", "Seed");
  const base = await git(seed, "rev-parse", "HEAD");
  const serverRoot = join(root, "server");
  const repo = ref => join(serverRoot, "api", "git", ref);
  const addRoom = async ref => {
    await mkdir(dirname(repo(ref)), { recursive: true });
    await git(root, "clone", "--bare", seed, repo(ref));
    await git(repo(ref), "update-ref", `refs/heads/session/${ref}`, base);
  };
  await addRoom("room-a");
  await addRoom("room-b");
  const data = join(root, "runner");
  const server = pathToFileURL(serverRoot).href;
  const runner = () => new RunnerGit(server, "private-device-token", data);
  const advance = async (ref, sha) => git(repo(ref), "update-ref", `refs/heads/session/${ref}`, sha);
  return { root, seed, base, data, server, repo, addRoom, runner, advance };
}

test("successive turns and runner restarts reuse a real worktree and retain ignored files", async t => {
  const f = await fixture(t);
  let path;
  const first = job(f.base);
  const sha = await f.runner().withWorkspace(first, async workspace => {
    path = workspace.path;
    assert.equal((await lstat(join(path, ".git"))).isFile(), true);
    await writeFile(join(path, ".env.local"), "LOCAL_CONFIG=kept\n");
    await mkdir(join(path, "node_modules"));
    await writeFile(join(path, "node_modules", "installed.txt"), "keep dependencies");
    await writeFile(join(path, "code.txt"), "first turn\n");
    return workspace.commitAndPush("First", author);
  });
  assert.equal(await git(f.repo("room-a"), "rev-parse", "session/room-a"), f.base, "candidate push must not advance the shared room");
  assert.equal(await git(f.repo("room-a"), "rev-parse", `refs/turns/${first.turnId}`), sha);
  await f.advance("room-a", sha);
  await f.runner().withWorkspace(job(sha), async workspace => {
    assert.equal(workspace.path, path);
    assert.equal(await readFile(join(path, ".env.local"), "utf8"), "LOCAL_CONFIG=kept\n");
    assert.equal(await readFile(join(path, "node_modules", "installed.txt"), "utf8"), "keep dependencies");
    assert.equal(await workspace.commitAndPush("No changes", author), null);
  });
  const config = await readFile(join(await common(path), "config"), "utf8");
  assert.doesNotMatch(config, /private-device-token|extraHeader|file:\/\//);
});

test("two rooms share repository storage but have separate branches and editable files", async t => {
  const f = await fixture(t);
  await f.runner().withWorkspace(job(f.base), async a => {
    await writeFile(join(a.path, "code.txt"), "room A unfinished\n");
    await f.runner().withWorkspace(job(f.base, { sessionId: "room-b" }), async b => {
      assert.notEqual(a.path, b.path);
      assert.notEqual(a.branch, b.branch);
      assert.equal(await common(a.path), await common(b.path));
      assert.equal(await readFile(join(b.path, "code.txt"), "utf8"), "initial\n");
      await writeFile(join(b.path, "code.txt"), "room B\n");
      await b.commitAndPush("B", author);
    });
    assert.equal(await readFile(join(a.path, "code.txt"), "utf8"), "room A unfinished\n");
    await a.commitAndPush("A", author);
  });
});

test("same workspace cannot be acquired by overlapping runner instances", async t => {
  const f = await fixture(t);
  await f.runner().withWorkspace(job(f.base), async () => {
    await assert.rejects(f.runner().withWorkspace(job(f.base), async () => assert.fail("second agent started")), /Workspace is in use/);
  });
  await f.runner().withWorkspace(job(f.base), async () => {});
});

test("workspace lock is respected by another OS process", async t => {
  const f = await fixture(t);
  await f.runner().withWorkspace(job(f.base), async () => {
    const script = `import { RunnerGit } from ${JSON.stringify(new URL("../runner/git.ts", import.meta.url).href)};
      const runner = new RunnerGit(process.env.TEST_SERVER, "token", process.env.TEST_DATA);
      try { await runner.withWorkspace(JSON.parse(process.env.TEST_JOB), async () => {}); process.exitCode = 2; }
      catch (error) { if (!error.message.includes("Workspace is in use")) throw error; console.log("blocked"); }`;
    const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, TEST_SERVER: f.server, TEST_DATA: f.data, TEST_JOB: JSON.stringify(job(f.base)) },
    });
    assert.match(stdout, /blocked/);
  });
});

test("dirty tracked and untracked files survive a failed turn and block reuse", async t => {
  const f = await fixture(t);
  let path;
  await assert.rejects(f.runner().withWorkspace(job(f.base), async workspace => {
    path = workspace.path;
    await writeFile(join(path, "code.txt"), "unfinished\n");
    await writeFile(join(path, "notes.txt"), "untracked work\n");
    throw new Error("Agent interrupted");
  }), /Agent interrupted/);
  await assert.rejects(f.runner().withWorkspace(job(f.base), async () => assert.fail("must not execute")), /unfinished edits/);
  assert.equal(await readFile(join(path, "code.txt"), "utf8"), "unfinished\n");
  assert.equal(await readFile(join(path, "notes.txt"), "utf8"), "untracked work\n");
});

test("handoff fetches accepted changes into each device's existing workspace", async t => {
  const f = await fixture(t);
  const bob = new RunnerGit(f.server, "bob-token", join(f.root, "bob-runner"));
  let bobPath;
  await bob.withWorkspace(job(f.base, { userId: "bob" }), async w => { bobPath = w.path; });
  const sha = await f.runner().withWorkspace(job(f.base), async w => {
    await writeFile(join(w.path, "code.txt"), "Alice's accepted work\n");
    return w.commitAndPush("Alice", author);
  });
  await f.advance("room-a", sha);
  await bob.withWorkspace(job(sha, { userId: "bob" }), async w => {
    assert.equal(w.path, bobPath);
    assert.equal(await git(w.path, "rev-parse", "HEAD"), sha);
    assert.equal(await readFile(join(w.path, "code.txt"), "utf8"), "Alice's accepted work\n");
  });
});

test("a candidate not accepted by the server is preserved and prevents reset to an older base", async t => {
  const f = await fixture(t);
  let path;
  const turn = job(f.base);
  const sha = await f.runner().withWorkspace(turn, async w => {
    path = w.path;
    await writeFile(join(path, "code.txt"), "candidate\n");
    return w.commitAndPush("Candidate", author);
  });
  await assert.rejects(f.runner().withWorkspace(job(f.base), async () => {}), /commits not included/);
  assert.equal(await git(path, "rev-parse", "HEAD"), sha);
  assert.equal(await git(path, "rev-parse", `refs/turns/${turn.turnId}`), sha);
});

test("failed candidate push retains local commit and does not expose the device token", async t => {
  const f = await fixture(t);
  await git(f.repo("room-a"), "config", "receive.denyCurrentBranch", "refuse");
  // A deterministic server-side rejection, without depending on a network outage.
  await writeFile(join(f.repo("room-a"), "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  let path;
  const turn = job(f.base);
  await assert.rejects(f.runner().withWorkspace(turn, async w => {
    path = w.path;
    await writeFile(join(path, "code.txt"), "undelivered\n");
    return w.commitAndPush("Fail push", author);
  }), error => /Git push failed/.test(error.message) && !error.message.includes("private-device-token"));
  const head = await git(path, "rev-parse", "HEAD");
  assert.notEqual(head, f.base);
  assert.equal(await git(path, "rev-parse", `refs/turns/${turn.turnId}`), head);
  await assert.rejects(f.runner().withWorkspace(job(f.base), async () => {}), /commits not included/);
});

test("ignored local configuration is not overwritten when a remote change starts tracking it", async t => {
  const f = await fixture(t);
  let path;
  await f.runner().withWorkspace(job(f.base), async w => {
    path = w.path;
    await writeFile(join(path, ".env.local"), "local-secret-value\n");
  });
  await writeFile(join(f.seed, ".env.local"), "remote-default\n");
  await git(f.seed, "add", "-f", ".env.local");
  await git(f.seed, "commit", "-m", "Track config");
  const next = await git(f.seed, "rev-parse", "HEAD");
  await git(f.seed, "push", f.repo("room-a"), "HEAD:refs/heads/session/room-a");
  await assert.rejects(f.runner().withWorkspace(job(next), async () => assert.fail("must not execute")), /Git merge failed/);
  assert.equal(await readFile(join(path, ".env.local"), "utf8"), "local-secret-value\n");
  assert.equal(await git(path, "rev-parse", "HEAD"), f.base);
});

test("completed or interrupted clean turns cannot replay after restarting the runner", async t => {
  const f = await fixture(t);
  const turn = job(f.base);
  await f.runner().withWorkspace(turn, async w => { assert.equal(await w.commitAndPush("Empty", author), null); });
  await assert.rejects(f.runner().withWorkspace(turn, async () => assert.fail("replayed")), /already started locally/);
});

test("user scopes and imported repositories do not share workspace caches", async t => {
  const f = await fixture(t);
  let primary;
  await f.runner().withWorkspace(job(f.base), async w => { primary = await common(w.path); });
  await f.runner().withWorkspace(job(f.base, { userId: "bob" }), async w => assert.notEqual(await common(w.path), primary));
  await f.runner().withWorkspace(job(f.base, { repoId: "room-b", projectRepositoryId: null }), async w => assert.notEqual(await common(w.path), primary));
});

test("an old job without projectId pins its cache and legacy turn directories stay untouched", async t => {
  const f = await fixture(t);
  const legacy = join(f.data, "work", randomUUID());
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, "unfinished.txt"), "legacy work\n");
  let path;
  await f.runner().withWorkspace(job(f.base, { projectId: undefined, projectRepositoryId: undefined }), async w => { path = w.path; });
  await f.runner().withWorkspace(job(f.base), async w => assert.equal(w.path, path));
  assert.equal(await readFile(join(legacy, "unfinished.txt"), "utf8"), "legacy work\n");
});

test("workspace handle cannot commit after its lock is released", async t => {
  const f = await fixture(t);
  let handle;
  await f.runner().withWorkspace(job(f.base), async w => { handle = w; });
  await assert.rejects(handle.commitAndPush("Late", author), /no longer available/);
});

test("abandoned process locks are not stolen on restart", async t => {
  const f = await fixture(t);
  const script = `import { RunnerGit } from ${JSON.stringify(new URL("../runner/git.ts", import.meta.url).href)};
    const runner = new RunnerGit(process.env.TEST_SERVER, "token", process.env.TEST_DATA);
    await runner.withWorkspace(JSON.parse(process.env.TEST_JOB), async () => { console.log("locked"); await new Promise(() => {}); });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, TEST_SERVER: f.server, TEST_DATA: f.data, TEST_JOB: JSON.stringify(job(f.base)) }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise(resolve => child.on("exit", resolve));
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  await exited; // Node exits with an unsettled top-level await, without finally.
  assert.match(output, /locked/);
  await assert.rejects(f.runner().withWorkspace(job(f.base), async () => {}), /Workspace is in use/);
  const [scope] = await readdir(join(f.data, "workspaces-v1"));
  const locks = await readdir(join(f.data, "workspaces-v1", scope, "locks"));
  assert.equal(locks.length, 1);
});


test("different repositories in one project never share a new cache", async t => {
  const f = await fixture(t);
  let first;
  await f.runner().withWorkspace(job(f.base), async w => { first = await common(w.path); });
  await f.runner().withWorkspace(job(f.base, { sessionId: "room-b", projectRepositoryId: "repository-b" }), async w => {
    assert.notEqual(await common(w.path), first);
  });
});

test("multiple repositories in the same room keep separate worktrees and reuse each independently", async t => {
  const f = await fixture(t);
  let primary, secondary;
  const first = { workspaceNames: { repository: "frontend", room: "Alice" } };
  const second = { repoId: "room-b", projectRepositoryId: "repository-b", workspaceNames: { repository: "backend", room: "Alice" } };
  await f.runner().withWorkspace(job(f.base, first), async w => { primary = w.path; });
  await f.runner().withWorkspace(job(f.base, second), async w => { secondary = w.path; });
  assert.notEqual(dirname(primary), dirname(secondary));
  assert.notEqual(await common(primary), await common(secondary));
  await writeFile(join(primary, "notes.txt"), "unfinished frontend work");
  await f.runner().withWorkspace(job(f.base, second), async w => assert.equal(w.path, secondary));
  await assert.rejects(f.runner().withWorkspace(job(f.base, first), async () => assert.fail("dirty primary executed")), /unfinished edits/);
  assert.equal(await readFile(join(primary, "notes.txt"), "utf8"), "unfinished frontend work");
});


test("named worktrees group by repository then room; all chats reuse the room checkout", async t => {
  const f = await fixture(t);
  const visible = join(f.root, "Visible workspaces");
  const runner = new RunnerGit(f.server, "token", f.data, visible);
  const names = { repository: "Multicode AI", room: "Alice's room" };
  let first, second;
  await runner.withWorkspace(job(f.base, { runId: randomUUID(), workspaceNames: names }), async w => { first = w.path; });
  await runner.withWorkspace(job(f.base, { runId: randomUUID(), workspaceNames: names }), async w => assert.equal(w.path, first));
  await runner.withWorkspace(job(f.base, { sessionId: "room-b", workspaceNames: { ...names, room: "Bob" } }), async w => { second = w.path; });
  assert.match(relative(visible, first).replaceAll("\\", "/"), /^multicode-ai--[a-f0-9]{12}\/alice-s-room--[a-f0-9]{12}$/);
  assert.equal(dirname(first), dirname(second));
  assert.notEqual(first, second);
  assert.equal(await common(first), await common(second));
  const workspaces = await listLocalWorkspaces(f.data);
  assert.equal(workspaces.length, 2);
  assert.equal(workspaces.find(w => w.path === first).repository, "Multicode AI");
});

test("renames and changing the root do not strand an existing worktree", async t => {
  const f = await fixture(t);
  const initialRoot = join(f.root, "first"), nextRoot = join(f.root, "second");
  let original;
  await new RunnerGit(f.server,"token",f.data,initialRoot).withWorkspace(job(f.base, { workspaceNames: { repository: "backend", room: "old-name" } }), async w => { original = w.path; });
  const runner = new RunnerGit(f.server,"token",f.data,nextRoot);
  await runner.withWorkspace(job(f.base, { workspaceNames: { repository: "renamed", room: "new-name" } }), async w => assert.equal(w.path, original));
  await runner.withWorkspace(job(f.base, { sessionId: "room-b", workspaceNames: { repository: "renamed", room: "second-room" } }), async w => {
    assert.ok(w.path.startsWith(nextRoot));
    assert.equal(dirname(relative(nextRoot, w.path)), dirname(relative(initialRoot, original)));
  });
});

async function legacyWorkspace(f) {
  let work;
  const oldTurn = job(f.base);
  await f.runner().withWorkspace(oldTurn, async w => { work = w.path; });
  const [scope] = await readdir(join(f.data, "workspaces-v1"));
  const root = join(f.data, "workspaces-v1", scope);
  const [file] = await readdir(join(root, "bindings"));
  const bindingPath = join(root, "bindings", file);
  const binding = JSON.parse(await readFile(bindingPath, "utf8"));
  const cache = await common(work), legacy = join(root, "work", file.slice(0, -5));
  await mkdir(dirname(legacy), { recursive: true });
  await git(cache, "worktree", "move", work, legacy);
  await writeFile(bindingPath, JSON.stringify({ version: 1, repoRef: binding.repoRef, cacheKey: binding.cacheKey }));
  await rm(join(root, "layouts"), { recursive: true, force: true });
  return { legacy, cache, bindingPath, oldTurn };
}

test("upgrading a v1 worktree moves it with Git and preserves ignored files and replay markers", async t => {
  const f = await fixture(t), old = await legacyWorkspace(f);
  await writeFile(join(old.legacy, ".env.local"), "PRIVATE=kept\n");
  let migrated;
  await f.runner().withWorkspace(job(f.base, { workspaceNames: { repository: "frontend", room: "Alice" } }), async w => {
    migrated = w.path;
    assert.equal(await common(w.path), old.cache);
    assert.equal(await readFile(join(w.path, ".env.local"), "utf8"), "PRIVATE=kept\n");
    assert.equal((await lstat(join(w.path, ".git"))).isFile(), true);
  });
  assert.notEqual(migrated, old.legacy);
  await assert.rejects(lstat(old.legacy), { code: "ENOENT" });
  await assert.rejects(f.runner().withWorkspace(old.oldTurn, async () => assert.fail("replayed")), /already started locally/);
});

test("upgrade preserves staged, unstaged, untracked and ignored work and refuses agent execution", async t => {
  const f = await fixture(t), old = await legacyWorkspace(f);
  await writeFile(join(old.legacy, "code.txt"), "staged change\n");
  await git(old.legacy,"add","code.txt");
  await writeFile(join(old.legacy, "code.txt"), "unstaged change\n");
  await writeFile(join(old.legacy, "notes.txt"), "untracked notes\n");
  await writeFile(join(old.legacy, ".env.local"), "LOCAL=secret\n");
  await assert.rejects(f.runner().withWorkspace(job(f.base), async () => assert.fail("dirty workspace executed")), /unfinished edits/);
  const [workspace] = await listLocalWorkspaces(f.data);
  assert.equal(await git(workspace.path,"show",":code.txt"), "staged change");
  assert.equal(await readFile(join(workspace.path,"code.txt"),"utf8"),"unstaged change\n");
  assert.equal(await readFile(join(workspace.path,"notes.txt"),"utf8"),"untracked notes\n");
  assert.equal(await readFile(join(workspace.path,".env.local"),"utf8"),"LOCAL=secret\n");
  assert.equal(await git(workspace.path,"rev-parse","HEAD"),f.base);
});

test("hostile display names cannot choose filesystem paths and corrupt locations fail closed", async t => {
  const f = await fixture(t);
  const root = join(f.root,"visible");
  await new RunnerGit(f.server,"token",f.data,root).withWorkspace(job(f.base, { workspaceNames: { repository: "../../CON:<backend>", room: "/tmp/../NUL" } }), async w => {
    const parts = relative(root,w.path).split(/[\\/]/);
    assert.equal(parts.length,2);
    for (const part of parts) assert.match(part,/^[a-z0-9-]+--[a-f0-9]{12}$/);
  });
  assert.throws(()=>locationPath({workspaceRoot:root,relativePath:"../../outside"}),/Invalid workspace/);
  assert.throws(()=>locationPath({workspaceRoot:"relative",relativePath:"repo--aaaaaaaaaaaa/room--bbbbbbbbbbbb"}),/Invalid workspace/);
});

test("CLI and desktop default to a visible directory under the user's home", async () => {
  // homedir() reads $HOME on POSIX, so each case gets its own empty home
  // rather than depending on what this machine happens to have.
  const original = process.env.HOME;
  const home = async layout => {
    const root = await mkdtemp(join(tmpdir(), "multicode-home-"));
    process.env.HOME = root;
    for (const path of layout) await mkdir(join(root, path), { recursive: true });
    return root;
  };
  try {
    const fresh = await home([]);
    assert.equal(defaultWorkspacesDir(), join(fresh, "multicode-ai", "workspaces"));
    assert.equal(resolveWorkspacesDir("~/my-worktrees"), join(fresh, "my-worktrees"));

    // The Multicode AI rename must not make an existing checkout disappear:
    // a home that only has the pre-rename directory keeps using it.
    const upgraded = await home(["multiplayer-ai/workspaces"]);
    assert.equal(defaultWorkspacesDir(), join(upgraded, "multiplayer-ai", "workspaces"));

    // Once the current directory exists it wins, so the fallback cannot pin a
    // migrated install to the old name forever.
    const both = await home(["multiplayer-ai/workspaces", "multicode-ai/workspaces"]);
    assert.equal(defaultWorkspacesDir(), join(both, "multicode-ai", "workspaces"));
  } finally {
    if (original === undefined) delete process.env.HOME; else process.env.HOME = original;
  }
});

test("restore collision checks protect ignored files and directories in large projects", () => {
  for (const [local,incoming] of [["config","config"],["config","config/key"],["config/key","config"]]) {
    assert.equal(checkpointOverwritesIgnored([local],[incoming]),true);
  }
  assert.equal(checkpointOverwritesIgnored(["config/local"],["config/source"]),false);
  assert.equal(checkpointOverwritesIgnored(["config-extra"],["config/key"]),false);
  const ignored=Array.from({length:30000},(_,n)=>`node_modules/package-${n}/index.js`);
  const incoming=Array.from({length:10000},(_,n)=>`src/module-${n}/index.ts`);
  assert.equal(checkpointOverwritesIgnored(ignored,incoming),false);
  assert.equal(checkpointOverwritesIgnored(ignored,[...incoming,"node_modules"]),true);
});

test("checkpoints survive restart and restore staged, unstaged and untracked state on another device", async t => {
  const f = await fixture(t);
  const original = job(f.base);
  let work, uploaded;
  await f.runner().withWorkspace(original, async w => {
    work = w.path;
    await writeFile(join(work, "code.txt"), "staged\n");
    await git(work, "add", "code.txt");
    await writeFile(join(work, "code.txt"), "unstaged\n");
    await writeFile(join(work, "new.txt"), "untracked\n");
    await writeFile(join(work, ".env.local"), "SECRET=local\n");
    await w.checkpoint();
    await w.checkpoint(); // unchanged trees must not produce another saved checkpoint
    assert.equal(await git(work, "show", ":code.txt"), "staged");
    assert.equal(await git(work, "rev-parse", "HEAD"), f.base);
  });
  let count = 0;
  await f.runner().deliverCheckpoints({ checkpoint: async snapshot => { count++; uploaded = snapshot; throw new Error("temporary metadata outage"); } });
  await f.runner().deliverCheckpoints({ checkpoint: async snapshot => { count++; uploaded = snapshot; } });
  assert.equal(count, 2);
  const bob = new RunnerGit(f.server, "bob", join(f.root, "bob-checkpoints"));
  await bob.withWorkspace(job(f.base, { restoreCheckpoint: uploaded }), async w => {
    assert.equal(await readFile(join(w.path, "code.txt"), "utf8"), "unstaged\n");
    assert.equal(await git(w.path, "show", ":code.txt"), "staged");
    assert.equal(await readFile(join(w.path, "new.txt"), "utf8"), "untracked\n");
    assert.match(await git(w.path, "status", "--porcelain"), /\?\? new.txt/);
    await assert.rejects(readFile(join(w.path, ".env.local")), { code: "ENOENT" });
    assert.equal(await git(w.path, "rev-parse", "HEAD"), f.base);
  });
  assert.equal(await readFile(join(work, ".env.local"), "utf8"), "SECRET=local\n");
});

test("background checkpoints capture manual edits and cannot leak another pairing's workspaces", async t => {
  const f = await fixture(t);
  let work;
  await f.runner().withWorkspace(job(f.base), async w => { work = w.path; await w.checkpoint(); });
  await f.runner().deliverCheckpoints({ checkpoint: async () => {} });
  await writeFile(join(work, "code.txt"), "manual edit between runs\n");
  await new RunnerGit(f.server, "another-pairing", f.data).checkpointIdleWorkspaces();
  let count = 0;
  await f.runner().deliverCheckpoints({ checkpoint: async () => { count++; } });
  assert.equal(count, 0);
  await f.runner().checkpointIdleWorkspaces();
  await f.runner().deliverCheckpoints({ checkpoint: async snapshot => { count++; assert.equal(snapshot.sequence, 2); } });
  assert.equal(count, 1);
});

// --- Parallel ("isolated") chats -------------------------------------------

/** A parallel chat on room-a whose server branch starts at `sha`. */
async function openChat(f, sha) {
  const runId = randomUUID();
  await git(f.repo("room-a"), "update-ref", `refs/heads/chat/${runId}`, sha);
  return runId;
}
const chatJob = (runId, baseSha, extra = {}) => job(baseSha, { runId, isolation: "isolated", chatBranch: `chat/${runId}`, ...extra });

test("parallel chats on one room repository run at once in their own worktrees and branches", async t => {
  const f = await fixture(t);
  const runner = f.runner();
  const [left, right] = [await openChat(f, f.base), await openChat(f, f.base)];
  let room;
  const turns = [chatJob(left, f.base, { workspaceNames: { repository: "app", room: "Alice", chat: "Fix login" } }), chatJob(right, f.base)];
  const results = await Promise.all(turns.map((turn, index) => runner.withWorkspace(turn, async w => {
    // Both chats hold their workspaces at the same time, and the room's own checkout stays free.
    if (index === 0) await runner.withWorkspace(job(f.base), async shared => { room = shared.path; });
    await writeFile(join(w.path, "code.txt"), `chat ${index}\n`);
    return { path: w.path, branch: w.branch, sha: await w.commitAndPush(`Chat ${index}`, author) };
  })));
  const [a, b] = results;
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.branch, b.branch);
  assert.notEqual(a.path, room);
  assert.equal(await common(a.path), await common(b.path), "chats share the repository cache");
  assert.match(relative(join(f.data, "workspaces"), a.path).replaceAll("\\", "/"), /\/alice-fix-login--[a-f0-9]{12}$/);
  assert.equal(await git(f.repo("room-a"), "rev-parse", `refs/turns/${turns[0].turnId}`), a.sha);
  assert.equal(await git(f.repo("room-a"), "rev-parse", `refs/turns/${turns[1].turnId}`), b.sha);
  assert.equal(await git(f.repo("room-a"), "rev-parse", "session/room-a"), f.base, "chats never move the room branch");
  assert.equal(await readFile(join(room, "code.txt"), "utf8"), "initial\n");
  const listed = await listLocalWorkspaces(f.data);
  assert.equal(listed.find(w => w.path === a.path).chat, "Fix login");
});

test("a parallel chat continues from its own server branch, never the room's", async t => {
  const f = await fixture(t);
  const chat = await openChat(f, f.base);
  let path;
  const sha = await f.runner().withWorkspace(chatJob(chat, f.base), async w => {
    path = w.path;
    await writeFile(join(w.path, "code.txt"), "chat work\n");
    return w.commitAndPush("Chat", author);
  });
  await git(f.repo("room-a"), "update-ref", `refs/heads/chat/${chat}`, sha);
  // The room moves on independently; its head is not on the chat's branch.
  const roomTurn = await f.runner().withWorkspace(job(f.base), async w => {
    await writeFile(join(w.path, "other.txt"), "room work\n");
    return w.commitAndPush("Room", author);
  });
  await f.advance("room-a", roomTurn);
  await assert.rejects(f.runner().withWorkspace(chatJob(chat, roomTurn), async () => assert.fail("ran on the room's base")), /merge-base failed/);
  await f.runner().withWorkspace(chatJob(chat, sha), async w => {
    assert.equal(w.path, path);
    assert.equal(await git(w.path, "rev-parse", "HEAD"), sha);
  });
});

test("a parallel chat job must name its own branch", async t => {
  const f = await fixture(t);
  const chat = await openChat(f, f.base);
  for (const bad of [{ chatBranch: `chat/${randomUUID()}` }, { chatBranch: "session/room-a" }, { runId: "not-a-uuid", chatBranch: "chat/not-a-uuid" }]) {
    await assert.rejects(f.runner().withWorkspace(chatJob(chat, f.base, bad), async () => assert.fail("ran")), /Invalid parallel chat identity/);
  }
});

test("an idle checkpoint in progress delays, rather than fails, an arriving turn", async t => {
  const f = await fixture(t);
  const runner = f.runner();
  let work;
  await runner.withWorkspace(job(f.base), async w => { work = w.path; await w.checkpoint(); });
  await writeFile(join(work, "code.txt"), "manual edit\n");
  const capture = runner.capture;
  let entered, release;
  const inside = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  runner.capture = async (...args) => { entered(); await gate; return capture.apply(runner, args); };
  const idle = runner.checkpointIdleWorkspaces();
  await inside; // The idle checkpoint now holds the workspace lock.
  let started = false;
  const turn = runner.withWorkspace(job(f.base), async () => { started = true; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(started, false, "the turn waits for the checkpoint");
  release();
  await idle;
  await assert.rejects(turn, /unfinished edits/, "then runs its usual checks instead of failing on the lock");
  runner.capture = capture;
});

test("idle checkpoints skip a workspace a turn of this runner holds", async t => {
  const f = await fixture(t);
  const runner = f.runner();
  await runner.withWorkspace(job(f.base), async w => { await w.checkpoint(); });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await runner.withWorkspace(job(f.base), async () => { await runner.checkpointIdleWorkspaces(); });
  } finally { console.error = original; }
  assert.deepEqual(errors, []);
});

test("a new parallel-chat worktree receives only allowlisted ignored files from the room", async t => {
  const f = await fixture(t);
  let room;
  await f.runner().withWorkspace(job(f.base), async w => {
    room = w.path;
    await writeFile(join(w.path, ".env.local"), "API_KEY=local\n");
    await writeFile(join(w.path, "code.txt"), "uncommitted room edit\n");
    await mkdir(join(w.path, "node_modules"));
    await writeFile(join(w.path, "node_modules", "big.txt"), "dependency");
  });
  const runner = new RunnerGit(f.server, "private-device-token", f.data, undefined, {
    copyIgnoredFiles: resolveCopyIgnoredFiles([".env.local", "code.txt", "node_modules/big.txt", "../outside", "missing.env"]),
  });
  const chat = await openChat(f, f.base);
  await runner.withWorkspace(chatJob(chat, f.base), async w => {
    assert.equal(await readFile(join(w.path, ".env.local"), "utf8"), "API_KEY=local\n");
    assert.equal(await readFile(join(w.path, "code.txt"), "utf8"), "initial\n", "tracked files are never copied");
    assert.equal(await readFile(join(w.path, "node_modules", "big.txt"), "utf8"), "dependency", "explicitly listed ignored files are copied");
    await assert.rejects(readFile(join(w.path, "missing.env")), { code: "ENOENT" });
  });
  assert.equal(await readFile(join(room, "code.txt"), "utf8"), "uncommitted room edit\n");
});

test("pruning removes only finished, clean chat worktrees the server already holds", async t => {
  const f = await fixture(t);
  const runner = f.runner();
  const paths = {};
  const finish = async (name, { edit, promote }) => {
    const chat = await openChat(f, f.base);
    const sha = await runner.withWorkspace(chatJob(chat, f.base, { workspaceNames: { repository: "app", room: "Alice", chat: name } }), async w => {
      paths[name] = w.path;
      await writeFile(join(w.path, "code.txt"), `${name}\n`);
      return w.commitAndPush(name, author);
    });
    if (promote) await git(f.repo("room-a"), "update-ref", `refs/heads/chat/${chat}`, sha);
    if (edit) await writeFile(join(paths[name], "notes.txt"), "unsaved\n");
    return chat;
  };
  const done = await finish("done", { promote: true });
  const dirty = await finish("dirty", { promote: true, edit: true });
  const rejected = await finish("rejected", { promote: false });
  const open = await finish("open", { promote: true });
  let room;
  await runner.withWorkspace(job(f.base), async w => { room = w.path; });
  const finished = new Set([done, dirty, rejected]);

  const preview = await runner.pruneChatWorkspaces("alice", finished, false);
  assert.deepEqual(preview.map(entry => [entry.chat, entry.removable]).sort(), [["dirty", false], ["done", true], ["rejected", false]]);
  assert.equal((await lstat(paths.done)).isDirectory(), true, "a preview deletes nothing");

  const applied = await runner.pruneChatWorkspaces("alice", finished, true);
  assert.match(applied.find(entry => entry.chat === "dirty").reason, /unsaved edits/);
  assert.match(applied.find(entry => entry.chat === "rejected").reason, /server does not have/);
  await assert.rejects(lstat(paths.done), { code: "ENOENT" });
  for (const kept of ["dirty", "rejected", "open"]) assert.equal((await lstat(paths[kept])).isDirectory(), true);
  assert.equal(await readFile(join(paths.dirty, "notes.txt"), "utf8"), "unsaved\n");
  assert.equal((await lstat(room)).isDirectory(), true, "room worktrees are never pruned");
  assert.equal((await listLocalWorkspaces(f.data)).some(w => w.path === paths.done), false);
  void open;
});

test("activity delivery always covers batches stored before the call", async t => {
  const root = await mkdtemp(join(tmpdir(), "activity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outbox = new ActivityOutbox(root, "https://server.test", "token");
  const delivered = [];
  let releaseFirst;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
  const api = { postEvents: async (turnId, events, sequence) => { if (sequence === 1) await firstHeld; delivered.push(`${turnId.slice(0, 1)}${sequence}`); } };
  const [a, b] = ["a" + randomUUID().slice(1), "b" + randomUUID().slice(1)];
  outbox.store(a, 1, [{ t: "out", d: "first" }]);
  const first = outbox.deliver(api);
  outbox.store(b, 1, [{ t: "out", d: "second" }]);
  outbox.store(b, 2, [{ t: "out", d: "final" }]);
  const second = outbox.deliver(api);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(delivered.sort(), ["a1", "b1", "b2"]);
});

test("runner parallelism and copy settings are validated", () => {
  assert.equal(resolveMaxParallel(undefined, "", null), Infinity, "no setting means no cap");
  assert.equal(resolveMaxParallel("2", "5"), 2);
  assert.equal(resolveMaxParallel("0", "abc", 5), 5);
  assert.equal(resolveMaxParallel(50), 50, "a chosen cap is honoured as given");
  assert.deepEqual(resolveCopyIgnoredFiles(".env, apps/web/.env.local ,../x,/etc/passwd,a/./b,.env"), [".env", "apps/web/.env.local"]);
});

test("terminals open in the chat's own worktree, else the room's, else nowhere on this computer", async t => {
  const f = await fixture(t);
  const runner = f.runner();
  let room, chatPath;
  await runner.withWorkspace(job(f.base), async w => { room = w.path; });
  const chat = await openChat(f, f.base);
  await runner.withWorkspace(chatJob(chat, f.base), async w => { chatPath = w.path; });
  const directory = input => runner.terminalDirectory({ userId: "alice", repoRef: "room-a", runId: null, isolated: false, ...input });
  assert.deepEqual(await directory({ runId: chat, isolated: true }), { path: chatPath, label: "parallel chat worktree" });
  assert.deepEqual(await directory({}), { path: room, label: "room worktree" });
  assert.deepEqual(await directory({ runId: randomUUID(), isolated: true }), { path: room, label: "room worktree" }, "a parallel chat that never ran here opens in its room's worktree");
  assert.equal(await directory({ repoRef: "room-b" }), null, "nothing ran here for that repository");
  assert.equal(await directory({ userId: "bob" }), null, "another account's worktrees are not reachable");
  assert.equal(await directory({ repoRef: "../room-a" }), null);
});
