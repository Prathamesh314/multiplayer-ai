/*
 * Terminals on this computer, for its owner, relayed through the server.
 *
 * Like an AI turn, a terminal opens in the chat's worktree here, with this
 * computer's own tools and logins. A real pseudo-terminal comes from Python's
 * standard `pty` module (Python ships wherever Git's developer tools do on
 * macOS, and on Linux distributions), so the runner stays free of native
 * modules. Without it (or on Windows) a basic interactive shell is used and
 * the terminal says so.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** Bridges a PTY to stdio; fd 3 carries `{"cols":n,"rows":n}` lines for resizes. */
const PTY_HELPER = String.raw`
import fcntl, json, os, pty, select, signal, struct, sys, termios
shell, cols, rows = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, "-l"])
def size(c, r):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    except OSError:
        pass
size(cols, rows)
watch, control = [fd, 0, 3], b""
while fd in watch:
    try:
        ready = select.select(watch, [], [])[0]
    except InterruptedError:
        continue
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        os.write(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            watch.remove(0)
            os.kill(pid, signal.SIGHUP)
        while data:
            data = data[os.write(fd, data):]
    if 3 in ready:
        chunk = os.read(3, 4096)
        if not chunk:
            watch.remove(3)
        control += chunk
        while b"\n" in control:
            line, control = control.split(b"\n", 1)
            try:
                message = json.loads(line)
                size(int(message["cols"]), int(message["rows"]))
            except Exception:
                pass
status = os.waitpid(pid, 0)[1]
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else 0)
`;

/** Recent output kept per terminal, replayed when a browser tab reattaches. */
const RING_BYTES = 256 * 1024;
/** How long a terminal outlives its last viewer, so a reload can reattach. */
export const DETACH_GRACE_MS = 60_000;
const FLUSH_MS = 40;
const FLUSH_BYTES = 64 * 1024;

export type TerminalReport = { id: string; output: string } | { id: string; exit: number | null } | { id: string; notice: string };
export type TerminalOpen = { id: string; userId: string; cols: number; rows: number; repoRef: string | null; runId: string | null; isolated: boolean };
export type TerminalDirectory = { path: string; label: string } | null;

type Session = {
  child: ChildProcess;
  pty: boolean;
  ring: Buffer;
  pending: Buffer[];
  pendingBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  sending: Promise<void>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
};

/** The first working `python3` with the `pty` module, or null. Not on Windows, which has no pty. */
export function findPtyPython(platform = process.platform): string | null {
  if (platform === "win32") return null;
  for (const candidate of ["python3", "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"]) {
    const probe = spawnSync(candidate, ["-c", "import pty, termios, fcntl"], { stdio: "ignore", timeout: 5000 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

export function defaultShell(platform = process.platform, env = process.env): string {
  if (platform === "win32") return env.COMSPEC || "powershell.exe";
  if (env.SHELL && existsSync(env.SHELL)) return env.SHELL;
  return ["/bin/zsh", "/bin/bash", "/bin/sh"].find(existsSync) ?? "/bin/sh";
}

/** This computer's environment for a member's shell, minus what only the runner process needs. */
export function shellEnvironment(env = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  for (const key of Object.keys(result)) {
    // The desktop app runs the runner as Electron-as-Node; a shell inheriting
    // that would break Electron apps (editors) started from it.
    if (key.startsWith("ELECTRON_") || key.startsWith("GIT_") || key === "RUNNER_CONFIG") delete result[key];
  }
  return result;
}

export class TerminalHost {
  private readonly sessions = new Map<string, Session>();
  private readonly python: string | null;
  private readonly shell: string;

  constructor(
    private readonly report: (report: TerminalReport) => Promise<void>,
    private readonly directory: (open: TerminalOpen) => Promise<TerminalDirectory>,
    options: { python?: string | null; shell?: string } = {},
  ) {
    this.python = options.python !== undefined ? options.python : findPtyPython();
    this.shell = options.shell ?? defaultShell();
  }

  /** Dispatch a server signal; unknown or malformed messages are ignored. */
  handle(type: string, data: unknown): void {
    const message = (data ?? {}) as Record<string, unknown>;
    const id = typeof message.id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(message.id) ? message.id : null;
    if (!id) return;
    const size = (value: unknown, fallback: number, min: number, max: number) => Math.min(Math.max(Number(value) || fallback, min), max);
    if (type === "terminal.open") {
      void this.open({ id, userId: String(message.userId ?? ""), cols: size(message.cols, 80, 10, 500), rows: size(message.rows, 24, 5, 200),
        repoRef: typeof message.repoRef === "string" ? message.repoRef : null, runId: typeof message.runId === "string" ? message.runId : null,
        isolated: message.isolated === true }).catch(cause => void this.report({ id, notice: `The terminal could not start: ${String(cause)}` }).catch(() => {}));
    } else if (type === "terminal.input" && typeof message.data === "string") this.input(id, message.data);
    else if (type === "terminal.resize") this.resize(id, size(message.cols, 80, 10, 500), size(message.rows, 24, 5, 200));
    else if (type === "terminal.kill") this.kill(id);
    else if (type === "terminal.detach") this.detach(id);
  }

  /** Open a shell in the chat's worktree, or reattach and replay recent output. */
  async open(open: TerminalOpen): Promise<void> {
    const existing = this.sessions.get(open.id);
    if (existing && !existing.exited) {
      if (existing.graceTimer) clearTimeout(existing.graceTimer);
      existing.graceTimer = null;
      if (existing.ring.length) await this.send({ id: open.id, output: existing.ring.toString("base64") });
      this.resize(open.id, open.cols, open.rows);
      return;
    }
    const directory = await this.directory(open);
    const cwd = directory?.path ?? homedir();
    const env = shellEnvironment();
    const child = this.python
      ? spawn(this.python, ["-c", PTY_HELPER, this.shell, String(open.cols), String(open.rows)], { cwd, env, stdio: ["pipe", "pipe", "pipe", "pipe"] })
      : spawn(this.shell, process.platform === "win32" ? [] : ["-i"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const session: Session = { child, pty: !!this.python, ring: Buffer.alloc(0), pending: [], pendingBytes: 0, flushTimer: null, sending: Promise.resolve(), graceTimer: null, exited: false };
    this.sessions.set(open.id, session);
    const notices = [
      directory ? `Terminal on this computer · ${directory.label} · ${directory.path}`
        : open.repoRef ? "This chat has no worktree on this computer yet; it is created by the first AI turn here. Opened your home folder."
        : `Terminal on this computer · ${cwd}`,
      ...(this.python ? [] : ["Basic terminal: full-screen programs and Tab completion need Python 3 on this computer."]),
    ];
    for (const notice of notices) await this.send({ id: open.id, notice });
    const output = (chunk: Buffer) => this.output(open.id, session, chunk);
    child.stdout?.on("data", output);
    child.stderr?.on("data", output);
    child.on("error", cause => void this.send({ id: open.id, notice: `The shell could not start: ${cause.message}` }));
    child.on("close", code => {
      session.exited = true;
      if (session.graceTimer) clearTimeout(session.graceTimer);
      this.flush(open.id, session);
      session.sending = session.sending.then(() => this.send({ id: open.id, exit: code })).catch(() => {});
      this.sessions.delete(open.id);
    });
  }

  input(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.exited) return;
    // A basic (non-PTY) shell gets no line discipline: turn Enter into a newline.
    session.child.stdin?.write(session.pty ? data : data.replace(/\r/g, "\n"));
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session?.pty || session.exited) return;
    (session.child.stdio[3] as NodeJS.WritableStream | undefined)?.write(`${JSON.stringify({ cols, rows })}\n`);
  }

  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.exited) return;
    // Closing stdin hangs up the shell (the helper sends SIGHUP); force it if it lingers.
    session.child.stdin?.end();
    const force = setTimeout(() => { if (!session.exited) session.child.kill("SIGKILL"); }, 2000);
    force.unref?.();
  }

  /** The last viewer left: keep the shell briefly so a reload can reattach. */
  detach(id: string): void {
    const session = this.sessions.get(id);
    if (!session || session.exited) return;
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.graceTimer = setTimeout(() => this.kill(id), DETACH_GRACE_MS);
    session.graceTimer.unref?.();
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  private output(id: string, session: Session, chunk: Buffer): void {
    session.ring = Buffer.concat([session.ring, chunk]);
    if (session.ring.length > RING_BYTES) session.ring = session.ring.subarray(session.ring.length - RING_BYTES);
    session.pending.push(chunk);
    session.pendingBytes += chunk.length;
    if (session.pendingBytes >= FLUSH_BYTES) this.flush(id, session);
    else session.flushTimer ??= setTimeout(() => this.flush(id, session), FLUSH_MS);
  }

  /** Send buffered output in order: one batch at a time, never interleaved. */
  private flush(id: string, session: Session): void {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.flushTimer = null;
    if (!session.pending.length) return;
    const output = Buffer.concat(session.pending).toString("base64");
    session.pending = [];
    session.pendingBytes = 0;
    session.sending = session.sending.then(() => this.send({ id, output })).catch(() => {});
  }

  private async send(report: TerminalReport): Promise<void> {
    try { await this.report(report); } catch { /* the viewer reconnects and the ring buffer replays */ }
  }
}
