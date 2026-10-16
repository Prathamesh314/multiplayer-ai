/*
 * Asking the chat before the agent uses a tool that needs permission.
 *
 * The agent runs unattended, so its CLI cannot prompt in a terminal. When it
 * wants such a tool (a web fetch, an MCP connector, a shell command), this asks
 * the server, which shows the request in the chat; the member who is running
 * the chat allows or denies it there (see app/lib/ai/permissions.ts). The run's
 * time limit is paused while a person decides.
 */
import { randomUUID } from "node:crypto";

export type ToolRequest = {
  /** The tool as the CLI names it, e.g. WebFetch or mcp__claude_ai_Google_Drive__read_file_content. */
  tool: string;
  /** One line for the chat, e.g. "Fetch https://docs.google.com/…". */
  title: string;
  /** The full input, for a person to inspect. */
  detail?: string;
  /** What "always allow" would remember, or null when it cannot be remembered. */
  rule?: string | null;
};
export type ToolAnswer = { allow: boolean; always: boolean };
export type PermissionAsker = (request: ToolRequest) => Promise<ToolAnswer>;

export type PermissionTransport = {
  ask(body: ToolRequest & { id: string }): Promise<string>;
  status(id: string): Promise<{ status: string; remember?: boolean }>;
  expire(id: string): Promise<void>;
};

/** How long a request waits for a person before it is refused. */
export const PERMISSION_WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 1500;

const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/**
 * One turn's asker. Rules the chat always allows (and any allowed "always"
 * during this turn) are granted without asking again.
 */
export function permissionAsker(transport: PermissionTransport, allowed: string[] = [], options: {
  signal?: AbortSignal; waitMs?: number; pollMs?: number; onWaiting?: (request: ToolRequest) => void;
} = {}): PermissionAsker {
  const remembered = new Set(allowed);
  return async (request) => {
    if (request.rule && remembered.has(request.rule)) return { allow: true, always: true };
    const id = randomUUID();
    let status = await transport.ask({ ...request, id });
    if (status === "pending") options.onWaiting?.(request);
    const until = Date.now() + (options.waitMs ?? PERMISSION_WAIT_MS);
    let remember = false;
    while (status === "pending") {
      if (options.signal?.aborted || Date.now() >= until) {
        await transport.expire(id).catch(() => {});
        return { allow: false, always: false };
      }
      await delay(options.pollMs ?? POLL_MS, options.signal);
      const answer = await transport.status(id).catch(() => ({ status: "pending" as string, remember: false }));
      status = answer.status;
      remember = answer.remember === true;
    }
    const allow = status === "allowed";
    if (allow && remember && request.rule) remembered.add(request.rule);
    return { allow, always: allow && remember };
  };
}

/** A time limit that stops counting while someone is deciding. */
export class Deadline {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remaining: number;
  private startedAt = 0;
  private holds = 0;
  constructor(ms: number, private readonly onExpire: () => void) { this.remaining = ms; this.arm(); }
  private arm() {
    this.startedAt = Date.now();
    this.timer = setTimeout(this.onExpire, Math.max(0, this.remaining));
    this.timer.unref?.();
  }
  pause() {
    if (this.holds++ > 0 || !this.timer) return;
    clearTimeout(this.timer); this.timer = null;
    this.remaining -= Date.now() - this.startedAt;
  }
  resume() {
    if (--this.holds > 0 || this.timer || this.remaining === Infinity) return;
    this.arm();
  }
  clear() { if (this.timer) clearTimeout(this.timer); this.timer = null; this.remaining = Infinity; }
  /** Run `work` with the limit paused. */
  async hold<T>(work: () => Promise<T>): Promise<T> { this.pause(); try { return await work(); } finally { this.resume(); } }
}
