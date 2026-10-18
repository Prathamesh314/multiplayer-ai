import { queryOne } from "../db/client";
import { events, type TerminalStreamEvent } from "../events";
import { localRunnersEnabled } from "../runner/jobs";
import { DEVICE_ONLINE_MS } from "../runner/devices";
import { access, denied } from "../session/auth";

/*
 * Terminals on members' own computers.
 *
 * As with AI agents, a terminal opens on the member's computer, in the
 * worktree of the chat it belongs to, with their own tools and logins. This
 * server only relays: a browser's keystrokes go to the runner on that
 * computer (over its `device:<id>` event channel), and the runner's output
 * comes back to that member's browser on `terminal:<user>:<terminal>`.
 *
 * Only the owner of a computer can reach its terminals: a terminal is bound
 * to the account that opened it, the device is always one of that account's,
 * and a runner can only publish to its own owner's channels.
 */

/** Runners can connect, so terminals open on members' computers. */
export function computerTerminals(): boolean {
  return localRunnersEnabled();
}

export type TerminalDevice = { id: string; name: string };
export type TerminalContext = { repoRef: string | null; runId: string | null; isolated: boolean };

/**
 * The member's computer to open a terminal on: the one that last ran this chat
 * (it holds the chat's worktree) when it is online, otherwise their most
 * recently seen computer. Only computers that host terminals qualify.
 */
export async function pickTerminalDevice(userId: string, runId: string | null): Promise<TerminalDevice | null> {
  return queryOne<TerminalDevice>(
    `SELECT d.id, d.name FROM runner_devices d
      WHERE d.user_id = $1 AND d.revoked_at IS NULL AND d.supports_terminal
        AND d.last_seen_at > now() - make_interval(secs => $2)
      ORDER BY (d.id = (SELECT assigned_device_id FROM agent_runs WHERE id = $3)) DESC NULLS LAST, d.last_seen_at DESC
      LIMIT 1`,
    [userId, DEVICE_ONLINE_MS / 1000, runId],
  );
}

/**
 * Which terminal belongs to whom and runs where. Process-local: the gateway
 * sends every request for one terminal id to the same web process (`lb_policy
 * query id` for /api/terminal/*), exactly as for server-side shells.
 */
type Remote = { userId: string; deviceId: string };
const globalStore = globalThis as unknown as { __mp_remoteTerminals?: Map<string, Remote> };
const remotes: Map<string, Remote> = (globalStore.__mp_remoteTerminals ??= new Map());

export const userChannel = (userId: string, id: string) => `terminal:${userId}:${id}`;
const deviceChannel = (deviceId: string) => `device:${deviceId}`;

/** Open (or reattach to) a terminal on `device`, and stream its output to `onEvent`. */
export async function openRemote(input: {
  id: string; userId: string; device: TerminalDevice; cols: number; rows: number; context: TerminalContext;
  onEvent: (event: TerminalStreamEvent) => void;
}): Promise<() => Promise<void>> {
  const existing = remotes.get(input.id);
  if (existing && existing.userId !== input.userId) throw new Error("This terminal belongs to someone else.");
  remotes.set(input.id, { userId: input.userId, deviceId: existing?.deviceId ?? input.device.id });
  const deviceId = remotes.get(input.id)!.deviceId;
  const bus = await events();
  const unsubscribe = await bus.subscribe(userChannel(input.userId, input.id), event => {
    if (event.type === "terminal.output" || event.type === "terminal.exit" || event.type === "terminal.notice") input.onEvent(event);
  });
  await bus.publish(deviceChannel(deviceId), {
    type: "terminal.open", id: input.id, userId: input.userId, cols: input.cols, rows: input.rows,
    repoRef: input.context.repoRef, runId: input.context.runId, isolated: input.context.isolated, at: Date.now(),
  });
  return async () => {
    await unsubscribe();
    // The runner keeps the shell briefly, so a reconnecting tab can reattach.
    await bus.publish(deviceChannel(deviceId), { type: "terminal.detach", id: input.id, at: Date.now() }).catch(() => {});
  };
}

/** Keystrokes, resizes and kills for a terminal on a member's computer; false when it is not one. */
export async function controlRemote(id: string, userId: string, control:
  | { type: "input"; data: string } | { type: "resize"; cols: number; rows: number } | { type: "kill" }): Promise<boolean> {
  const remote = remotes.get(id);
  if (!remote || remote.userId !== userId) return false;
  const bus = await events();
  const at = Date.now();
  if (control.type === "input") await bus.publish(deviceChannel(remote.deviceId), { type: "terminal.input", id, data: control.data, at });
  else if (control.type === "resize") await bus.publish(deviceChannel(remote.deviceId), { type: "terminal.resize", id, cols: control.cols, rows: control.rows, at });
  else {
    remotes.delete(id);
    await bus.publish(deviceChannel(remote.deviceId), { type: "terminal.kill", id, at });
  }
  return true;
}

/** Whether `id` is a terminal on a member's computer that `userId` opened in this process. */
export function isRemote(id: string, userId: string): boolean {
  return remotes.get(id)?.userId === userId;
}

/** A runner's output, exit or notice for one of its owner's terminals. */
export async function relayFromRunner(ownerId: string, event: TerminalStreamEvent): Promise<void> {
  if (event.type === "terminal.exit") remotes.delete(event.id);
  await (await events()).publish(userChannel(ownerId, event.id), event);
}

/**
 * The worktree context a terminal asks for, checked against the caller's room
 * access: the room's repository, or a chat's (a parallel chat has its own).
 * No room means the computer's home directory.
 */
export async function terminalContext(userId: string, params: URLSearchParams): Promise<TerminalContext | { error: string; status: number }> {
  const sessionId = params.get("sessionId");
  if (!sessionId) return { repoRef: null, runId: null, isolated: false };
  const result = await access(sessionId);
  if (denied(result) || !result || result.user.id !== userId) return { error: "Room not found.", status: 404 };
  const runId = params.get("runId");
  if (runId) {
    const run = await queryOne<{ repo_id: string | null; isolation: string }>(
      `SELECT repo_id, isolation FROM agent_runs WHERE id = $1 AND session_id = $2 AND NOT agent_run_hidden(id, $3)`, [runId, sessionId, userId]);
    if (!run) return { error: "Chat not found.", status: 404 };
    return { repoRef: run.repo_id ?? sessionId, runId, isolated: run.isolation === "isolated" };
  }
  const repoId = params.get("repoId");
  if (repoId) {
    const repo = await queryOne(`SELECT id FROM room_repos WHERE id = $1 AND session_id = $2 AND NOT room_repo_hidden(id, $3)`, [repoId, sessionId, userId]);
    if (!repo) return { error: "Repository not found in this room.", status: 404 };
  }
  return { repoRef: repoId || sessionId, runId: null, isolated: false };
}
