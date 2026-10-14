import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { NO_SHELL_REASON, resolveShell } from "./shell";

/**
 * Real pseudo-terminals, one per client terminal tab.
 *
 * Unlike the old one-shot runner, each id here owns a persistent interactive
 * login shell — so Tab-completion, prompts, colours, and full-screen programs
 * (vim, top, REPLs) all work, because a real TTY is driving them. The SSE route
 * subscribes to output; the POST route writes keystrokes and resizes.
 *
 * The registry lives on globalThis so a dev-time module reload does not orphan
 * running shells, and because the SSE (GET) and control (POST) handlers must
 * reach the same map inside the one Next server process.
 *
 * Every shell records the account that created it. Ids are client-generated,
 * so without that an attacker who guessed (or was told) an id could attach to
 * someone else's live shell; with it, a mismatched owner is treated exactly
 * like a shell that does not exist.
 */

/** Recent output kept per shell, so a reconnecting terminal can repaint. */
const RING_BYTES = 256 * 1024;
/** Grace period after the last viewer leaves before the shell is reaped. */
const GRACE_MS = 10_000;

type Session = {
  pty: IPty;
  /** The account that opened this shell; nobody else may reach it. */
  ownerId: string;
  /** Tail of raw output, capped at RING_BYTES, replayed on (re)subscribe. */
  ring: string;
  subscribers: Set<(chunk: string) => void>;
  exitHandlers: Set<() => void>;
  graceTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
};

const globalStore = globalThis as unknown as { __mp_ptys?: Map<string, Session> };
const store: Map<string, Session> = (globalStore.__mp_ptys ??= new Map());


/** A shell `ownerId` is allowed to reach, or null (missing, dead, or theirs). */
function owned(id: string, ownerId: string): Session | null {
  const session = store.get(id);
  if (!session || session.ownerId !== ownerId) return null;
  return session;
}

export type StartResult = { ok: true } | { ok: false; status: number; reason: string };

/**
 * Returns the live shell for `id`, spawning one the first time.
 *
 * Both failures are reported rather than swallowed: an id already owned by
 * another account (told only "not available to you", so ids stay unguessable),
 * and a host with no shell to run — which used to present as a terminal that
 * opened and instantly died with nothing explaining why.
 */
export function getOrCreate(id: string, cols: number, rows: number, ownerId: string): StartResult {
  const existing = store.get(id);
  if (existing && existing.ownerId !== ownerId) {
    return { ok: false, status: 403, reason: "That terminal is not available." };
  }
  if (existing && !existing.exited) return { ok: true };

  const shell = resolveShell();
  if (!shell) return { ok: false, status: 503, reason: NO_SHELL_REASON };

  let term: IPty;
  try {
    term = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: Math.max(1, cols || 80),
      rows: Math.max(1, rows || 24),
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
  } catch (cause) {
    console.warn("Terminal shell failed to start", cause);
    return { ok: false, status: 503, reason: `The shell ${shell.file} could not be started on this server.` };
  }

  const session: Session = {
    pty: term,
    ownerId,
    ring: "",
    subscribers: new Set(),
    exitHandlers: new Set(),
    graceTimer: null,
    exited: false,
  };

  term.onData((chunk) => {
    session.ring = (session.ring + chunk).slice(-RING_BYTES);
    for (const fn of session.subscribers) fn(chunk);
  });

  term.onExit(() => {
    session.exited = true;
    if (session.graceTimer) clearTimeout(session.graceTimer);
    store.delete(id);
    for (const fn of session.exitHandlers) fn();
  });

  store.set(id, session);
  return { ok: true };
}

/**
 * Streams a shell's output to `onData` (after replaying its recent tail), and
 * calls `onExit` when the shell ends. The returned unsubscribe drops the viewer
 * and, once nobody is left watching, schedules the shell to be reaped.
 */
export function subscribe(
  id: string,
  ownerId: string,
  onData: (chunk: string) => void,
  onExit: () => void,
): () => void {
  const session = owned(id, ownerId);
  if (!session) {
    onExit();
    return () => {};
  }

  if (session.graceTimer) {
    clearTimeout(session.graceTimer);
    session.graceTimer = null;
  }
  if (session.ring) onData(session.ring);
  session.subscribers.add(onData);
  session.exitHandlers.add(onExit);

  return () => {
    session.subscribers.delete(onData);
    session.exitHandlers.delete(onExit);
    if (session.subscribers.size === 0 && !session.exited) {
      session.graceTimer = setTimeout(() => destroy(id), GRACE_MS);
      session.graceTimer.unref?.();
    }
  };
}

export function write(id: string, ownerId: string, data: string): boolean {
  const session = owned(id, ownerId);
  if (!session || session.exited) return false;
  session.pty.write(data);
  return true;
}

export function resize(id: string, ownerId: string, cols: number, rows: number): boolean {
  const session = owned(id, ownerId);
  if (!session || session.exited) return false;
  try {
    session.pty.resize(Math.max(1, cols), Math.max(1, rows));
  } catch {
    // A resize racing with exit can throw; harmless.
  }
  return true;
}

/**
 * Kills a shell and forgets it — used on tab close and after the grace period.
 * `ownerId` is omitted by the internal reaper, which is not acting for anyone.
 */
export function destroy(id: string, ownerId?: string): void {
  const session = ownerId === undefined ? store.get(id) : owned(id, ownerId);
  if (!session) return;
  store.delete(id);
  if (session.graceTimer) clearTimeout(session.graceTimer);
  try {
    session.pty.kill();
  } catch {
    // Already gone.
  }
}
