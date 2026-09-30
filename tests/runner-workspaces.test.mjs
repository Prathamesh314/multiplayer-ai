import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { RunnerGit } from "../runner/git.ts";

const exec = promisify(execFile);
const author = { name: "Workspace test", email: "workspace@example.test" };
const git = async (cwd, ...args) => (await exec("git", ["-c", "commit.gpgsign=false", "-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, ...args], { cwd })).stdout.trim();
const job = (baseSha, extra = {}) => ({ userId: "alice", sessionId: "room-a", repoId: null, projectId: "project-a", projectRepositoryId: "repository-a", turnId: randomUUID(), baseSha, ...extra });
const common = work => git(work, "rev-parse", "--path-format=absolute", "--git-common-dir");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "runner-workspaces-"));
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
