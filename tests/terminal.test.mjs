/**
 * The hosted terminal: what enables it, who may reach a shell, and which shell
 * actually gets spawned.
 *
 * The shell cases exist because of a real production failure — the POSIX
 * fallback was a hard-coded `/bin/zsh` that does not exist in the deployment
 * image, while the status endpoint advertised `/bin/sh`. node-pty does not
 * throw for a missing binary, so the terminal reported itself available and
 * then died instantly with no explanation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { terminalAccess } from "../app/lib/terminal/guard.ts";
import { resolveShell } from "../app/lib/terminal/shell.ts";
import { policyFor, policy } from "../app/lib/http/api-limit.ts";
import { KILL_AFTER_MS } from "../app/lib/terminal/pty.ts";

const request = (host = "localhost:3000") => new Request("http://x/api/terminal", { headers: { host } });

/**
 * Resolves or rejects, never hangs. A terminal test that waits forever turns a
 * failure into a 35-minute CI timeout with no diagnosis, which is exactly how
 * the leaked-shell bug first showed up.
 */
async function within(ms, label, body) {
  const deadline = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve(body()).finally(() => deadline.abort()),
      delay(ms, null, { signal: deadline.signal })
        .then(() => { throw Error(`timed out after ${ms}ms: ${label()}`); })
        .catch(cause => { if (cause.name !== "AbortError") throw cause; }),
    ]);
  } finally {
    deadline.abort();
  }
}

/** Runs `body` with the given env applied, restoring whatever was there. */
async function withEnv(values, body) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await body(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("the opt-in is the only thing that enables a hosted terminal", async () => {
  await withEnv({ MULTIPLAYER_AI_TERMINAL: undefined, NODE_ENV: "production" }, () => {
    const refusal = terminalAccess(request("multicode.in"));
    assert.equal(refusal.allowed, false);
    assert.match(refusal.reason, /disabled in production/);
    // A loopback Host must not be a way around the production gate.
    assert.equal(terminalAccess(request("localhost:3000")).allowed, false);
  });

  // Opting in lifts the Host rule too: on a hosted domain every request
  // arrives for the public name, which is what made the flag useless before.
  await withEnv({ MULTIPLAYER_AI_TERMINAL: "1", NODE_ENV: "production" }, () => {
    assert.equal(terminalAccess(request("multicode.in")).allowed, true);
  });

  // "0" wins everywhere, including development on loopback.
  await withEnv({ MULTIPLAYER_AI_TERMINAL: "0", NODE_ENV: "development" }, () => {
    const refusal = terminalAccess(request("localhost:3000"));
    assert.equal(refusal.allowed, false);
    assert.match(refusal.reason, /disabled by MULTIPLAYER_AI_TERMINAL/);
  });
});

test("development without the opt-in still only answers loopback", async () => {
  await withEnv({ MULTIPLAYER_AI_TERMINAL: undefined, NODE_ENV: "development" }, () => {
    assert.equal(terminalAccess(request("localhost:3000")).allowed, true);
    assert.equal(terminalAccess(request("127.0.0.1:3000")).allowed, true);
    assert.equal(terminalAccess(request("[::1]:3000")).allowed, true);
    const refusal = terminalAccess(request("multicode.in"));
    assert.equal(refusal.allowed, false);
    assert.match(refusal.reason, /loopback/);
  });
});

test("the shell is one that exists, not one that is merely conventional", async () => {
  const root = await mkdtemp(join(tmpdir(), "terminal-shell-"));
  await mkdir(join(root, "bin"), { recursive: true });
  const shell = join(root, "bin", "fakesh");
  await writeFile(shell, "#!/bin/sh\n");
  await chmod(shell, 0o755);
  const missing = join(root, "bin", "absent");

  await withEnv({ MULTIPLAYER_AI_SHELL: shell }, () => {
    assert.deepEqual(resolveShell(), { file: shell, args: ["-il"] });
  });

  // An explicit override that does not exist is an error, not a silent
  // fallback: the operator asked for something specific.
  await withEnv({ MULTIPLAYER_AI_SHELL: missing }, () => {
    assert.equal(resolveShell(), null);
  });

  // $SHELL names the login account's shell and can be absent in a container.
  // It is a preference, so it is skipped rather than spawned blindly.
  await withEnv({ MULTIPLAYER_AI_SHELL: undefined, SHELL: missing }, () => {
    const resolved = resolveShell();
    assert.ok(resolved, "a real shell should still be found");
    assert.notEqual(resolved.file, missing);
  });

  await withEnv({ MULTIPLAYER_AI_SHELL: undefined, SHELL: shell }, () => {
    assert.equal(resolveShell().file, shell);
  });
});

test("whatever is resolved is reachable and gets interactive login flags", () => {
  const resolved = resolveShell();
  assert.ok(resolved, "this machine must have some shell");
  assert.deepEqual(resolved.args, ["-il"], "a Bourne-family shell needs -il to be usable");
  // /bin/sh exists on every POSIX host, so resolution can never come back
  // empty here — the production failure was resolving to a path that did not.
  assert.ok(resolved.file.startsWith("/"), resolved.file);
});

test("a shell really starts, echoes what is typed, and is bound to its owner", async () => {
  // bash rather than the host's default: it is what the deployment image has,
  // and the failure being guarded against was image-specific.
  const bash = ["/bin/bash", "/usr/bin/bash", "/bin/sh"].find(path => existsSync(path));
  const { destroy, getOrCreate, subscribe, write } = await import("../app/lib/terminal/pty.ts");

  await withEnv({ MULTIPLAYER_AI_SHELL: bash }, async () => {
    const id = "test-" + randomUUID();
    assert.deepEqual(getOrCreate(id, 80, 24, "alice"), { ok: true });
    try {
      // Another account may not attach to, type into, or kill Alice's shell,
      // and is told nothing that would confirm the id exists.
      assert.deepEqual(getOrCreate(id, 80, 24, "mallory"),
        { ok: false, status: 403, reason: "That terminal is not available." });
      assert.equal(write(id, "mallory", "whoami\r"), false);
      let intercepted = "";
      subscribe(id, "mallory", chunk => { intercepted += chunk; }, () => {});

      let output = "";
      const seen = new Promise(resolve => {
        subscribe(id, "alice", chunk => { output += chunk; if (output.includes("brillig")) resolve(); }, () => {});
      });
      assert.equal(write(id, "alice", "echo bril''lig\r"), true);
      await within(15000, () => "no output from the shell: " + JSON.stringify(output), () => seen);
      assert.equal(intercepted, "", "another account must receive nothing");

      destroy(id, "mallory");
      assert.equal(write(id, "alice", "\r"), true, "a foreign kill must not end the shell");

      // The shell must actually be gone before this test returns. A surviving
      // shell holds the PTY's master fd, which holds the event loop, which
      // hangs the whole run rather than failing it.
      const gone = new Promise(resolve => subscribe(id, "alice", () => {}, resolve));
      destroy(id);
      await within(KILL_AFTER_MS + 8000, () => "the shell outlived destroy()", () => gone);
    } finally {
      destroy(id);
    }
  });
});

test("a shell that ignores SIGHUP is still killed, instead of pinning the process", async () => {
  // bash traps SIGHUP here, which is what the CI runner's login shell
  // effectively did: destroy() sent one polite signal and assumed it worked,
  // so the shell, its children and the master fd stayed for good.
  const bash = ["/bin/bash", "/usr/bin/bash"].find(path => existsSync(path));
  if (!bash) return; // dash cannot trap SIGHUP the same way; nothing to prove.
  const { destroy, getOrCreate, subscribe, write } = await import("../app/lib/terminal/pty.ts");

  await withEnv({ MULTIPLAYER_AI_SHELL: bash }, async () => {
    const id = "stubborn-" + randomUUID();
    assert.deepEqual(getOrCreate(id, 80, 24, "alice"), { ok: true });
    try {
      let output = "";
      const ready = new Promise(resolve => {
        subscribe(id, "alice", chunk => { output += chunk; if (output.includes("trapped")) resolve(); }, () => {});
      });
      write(id, "alice", "trap '' HUP; echo trap''ped\r");
      await within(15000, () => "shell never confirmed the trap: " + JSON.stringify(output), () => ready);

      const gone = new Promise(resolve => subscribe(id, "alice", () => {}, resolve));
      destroy(id);
      await within(KILL_AFTER_MS + 8000, () => "SIGHUP was ignored and no SIGKILL followed", () => gone);
    } finally {
      destroy(id);
    }
  });
});

test("keystrokes get their own allowance instead of the ordinary write budget", () => {
  assert.equal(policyFor("/api/terminal/pty", "POST"), "terminal");
  assert.equal(policyFor("/api/terminal/pty", "GET"), "stream");
  assert.equal(policyFor("/api/terminal", "GET"), "stream");

  // Typing at a normal speed is a few hundred requests a minute; the write
  // policy would reject most of them and the client discards a rejection.
  const terminal = policy("terminal", {});
  const write = policy("write", {});
  assert.ok(terminal.perMinute > 5 * write.perMinute, `${terminal.perMinute} vs ${write.perMinute}`);
  assert.ok(terminal.perMinute >= 600, "sustained typing must not be throttled");
});
