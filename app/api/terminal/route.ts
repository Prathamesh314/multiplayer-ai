import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { terminalAccess } from "../../lib/terminal/guard";
import type { RunRequest, TerminalEvent, TerminalStatus } from "../../lib/terminal/protocol";
import { MAX_OUTPUT_BYTES, MAX_RUN_MS } from "../../lib/terminal/protocol";
import { register, unregister } from "../../lib/terminal/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = terminalAccess(request);

  // Nothing about the host machine is disclosed when access is denied.
  const status: TerminalStatus = access.allowed
    ? {
        enabled: true,
        cwd: process.cwd(),
        shell: shellPath(),
        platform: process.platform,
      }
    : { enabled: false, reason: access.reason, cwd: "", shell: "", platform: "" };

  return Response.json(status, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const access = terminalAccess(request);
  if (!access.allowed) {
    return Response.json({ error: access.reason }, { status: 403 });
  }

  let body: RunRequest;
  try {
    body = (await request.json()) as RunRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const command = typeof body.command === "string" ? body.command.trim() : "";
  const runId = typeof body.runId === "string" ? body.runId : "";
  if (!command || !runId) {
    return Response.json({ error: "Both command and runId are required." }, { status: 400 });
  }

  const cwd = await resolveDirectory(body.cwd) ?? process.cwd();

  // `cd` has to be handled here: each command runs in its own shell, so a
  // directory change inside that shell would vanish with it.
  const target = parseStandaloneCd(command);
  if (target !== null) {
    const next = await resolveDirectory(target === "" ? homedir() : expand(target, cwd));
    return streamOf(
      next
        ? [{ t: "cwd", path: next }, { t: "exit", code: 0, signal: null, ms: 0 }]
        : [
            { t: "err", d: `cd: no such directory: ${target}\n` },
            { t: "exit", code: 1, signal: null, ms: 0 },
          ],
    );
  }

  return new Response(runStream(command, cwd, runId), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

function runStream(command: string, cwd: string, runId: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  let child: ChildProcess | undefined;
  let closed = false;
  let bytes = 0;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: TerminalEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(deadline);
        unregister(runId);
        controller.close();
      };

      const [file, args] = shellInvocation(command);
      let spawned: ChildProcess;
      try {
        spawned = spawn(file, args, {
          cwd,
          // Detached gives the child its own process group, so an interrupt can
          // reach the whole tree rather than just the shell.
          detached: process.platform !== "win32",
          env: { ...process.env, TERM: "xterm-256color", COLUMNS: "120", LINES: "40" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (cause) {
        send({ t: "err", d: `${cause instanceof Error ? cause.message : String(cause)}\n` });
        send({ t: "exit", code: null, signal: null, ms: Date.now() - startedAt });
        finish();
        return;
      }

      child = spawned;
      register(runId, spawned);
      send({ t: "start", pid: spawned.pid, cwd, command });

      const deadline = setTimeout(() => {
        send({ t: "notice", message: `Stopped after ${MAX_RUN_MS / 60_000} minutes.` });
        kill(spawned);
      }, MAX_RUN_MS);
      deadline.unref?.();

      const forward = (stream: Readable | null, kind: "out" | "err") => {
        if (!stream) return;
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          if (bytes >= MAX_OUTPUT_BYTES) return;
          bytes += Buffer.byteLength(chunk);
          send({ t: kind, d: chunk });
          if (bytes >= MAX_OUTPUT_BYTES) {
            send({ t: "notice", message: "Output limit reached — the command was stopped." });
            kill(spawned);
          }
        });
      };

      forward(spawned.stdout, "out");
      forward(spawned.stderr, "err");

      spawned.on("error", (cause) => {
        send({ t: "err", d: `${cause.message}\n` });
      });

      spawned.on("close", (code, signal) => {
        send({ t: "exit", code, signal, ms: Date.now() - startedAt });
        finish();
      });
    },

    cancel() {
      // The browser aborted (panel closed, page navigated): do not leave the
      // command running.
      closed = true;
      unregister(runId);
      if (child) kill(child);
    },
  });
}

/** Targets the whole process group so a shell's children die with it. */
function kill(child: ChildProcess): void {
  try {
    process.kill(-(child.pid ?? 0), "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

function streamOf(events: TerminalEvent[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } },
  );
}

function shellPath(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/sh";
}

function shellInvocation(command: string): [string, string[]] {
  if (process.platform === "win32") return [shellPath(), ["/d", "/s", "/c", command]];
  return [shellPath(), ["-c", command]];
}

/**
 * Returns the target of a plain `cd`, `""` for a bare `cd`, or null when the
 * command is anything else (including `cd x && y`, which the shell must run).
 */
function parseStandaloneCd(command: string): string | null {
  const match = /^cd(?:\s+([^&|;<>]+?))?\s*$/.exec(command);
  if (!match) return null;
  const argument = match[1]?.trim() ?? "";
  return argument.replace(/^['"]|['"]$/g, "");
}

function expand(target: string, cwd: string): string {
  const home = homedir();
  if (target === "~") return home;
  if (target.startsWith("~/")) return resolve(home, target.slice(2));
  return isAbsolute(target) ? target : resolve(cwd, target);
}

async function resolveDirectory(candidate: unknown): Promise<string | null> {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  const path = resolve(candidate);
  try {
    return (await stat(path)).isDirectory() ? path : null;
  } catch {
    return null;
  }
}
