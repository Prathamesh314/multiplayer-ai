import { spawn } from "node:child_process";
import { agentEnv } from "../app/lib/ai/env";
import { commandLine } from "../app/lib/ai/command";
import { WakeSignal } from "./signals";
import type { RunInput, LocalRunResult } from "./execute";
import { RunWatch, keepTail, runLimits, type ToolRequest } from "./permissions";

type ApprovalParams = {
  command?: string | null; reason?: string | null; grantRoot?: string | null;
  networkApprovalContext?: { host: string; protocol: string } | null;
  permissions?: { network: unknown; fileSystem: unknown };
  /** MCP tool calls arrive as elicitations (mcpServer/elicitation/request). */
  serverName?: string; message?: string;
  _meta?: { codex_approval_kind?: string; tool_description?: string; tool_params?: unknown } | null;
};
const MCP_ELICITATION = "mcpServer/elicitation/request";
/** What the chat shows for a Codex approval request, and what "always" remembers. */
export function describeCodexApproval(method: string, params: ApprovalParams): ToolRequest | null {
  const reason = params.reason ? ` (${params.reason})` : "";
  if (method === "item/commandExecution/requestApproval") {
    const host = params.networkApprovalContext?.host;
    if (host) return { tool: "network", title: `Connect to ${host}${reason}`.slice(0, 300), detail: params.command ?? undefined, rule: `CodexNetwork(${host})` };
    return { tool: "shell", title: `Run: ${params.command ?? "a command"}${reason}`.slice(0, 300), detail: params.command ?? undefined, rule: null };
  }
  if (method === "item/fileChange/requestApproval")
    return { tool: "write", title: `Write files${params.grantRoot ? ` under ${params.grantRoot}` : " outside the workspace"}${reason}`.slice(0, 300), rule: null };
  if (method === MCP_ELICITATION) {
    // Only Codex's own "may this MCP tool run?" question; a server asking the
    // person to fill in a form is refused.
    if (params._meta?.codex_approval_kind !== "mcp_tool_call" || !params.serverName) return null;
    const tool = /tool "([^"]{1,120})"/.exec(params.message ?? "")?.[1];
    const words = (value: string) => value.replace(/[_-]+/g, " ");
    return { tool: "mcp", title: `Use ${tool ? words(tool) : "a tool"} from ${words(params.serverName)}`.slice(0, 300),
      detail: JSON.stringify(params._meta.tool_params ?? {}, null, 2).slice(0, 4000),
      // Named like Claude Code's rule, so "always" for this chat reads the same for both.
      rule: tool && /^[A-Za-z0-9_.-]+$/.test(`${params.serverName}${tool}`) ? `mcp__${params.serverName}__${tool}` : null };
  }
  if (method === "item/permissions/requestApproval")
    return { tool: "permissions", title: `Extra access${params.permissions?.network ? ": network" : ""}${params.permissions?.fileSystem ? ": files outside the workspace" : ""}${reason}`.slice(0, 300),
      detail: JSON.stringify(params.permissions ?? {}, null, 2).slice(0, 4000), rule: null };
  return null;
}
/** The JSON-RPC result Codex expects for an approval decision. */
export function codexApprovalResult(method: string, params: ApprovalParams, allow: boolean, always: boolean) {
  // "always" means for this chat only: never "always" in Codex's own settings.
  if (method === MCP_ELICITATION) return allow ? { action: "accept", content: {}, ...(always ? { _meta: { persist: "session" } } : {}) } : { action: "decline" };
  if (method === "item/permissions/requestApproval") {
    const granted = allow ? Object.fromEntries(Object.entries(params.permissions ?? {}).filter(([, value]) => value != null)) : {};
    return { permissions: granted, scope: always ? "session" : "turn" };
  }
  return { decision: allow ? (always ? "acceptForSession" : "accept") : "decline" };
}

/** Codex's app-server keeps one thread alive and accepts native turn/steer input. */
export async function runCodexSession(input: RunInput): Promise<LocalRunResult> {
  const started = Date.now(), wake = new WakeSignal();
  const child = spawn(...commandLine(input.spec.bin, ["app-server"]), {
    cwd: input.cwd, detached: process.platform !== "win32", windowsHide: true,
    env: { ...agentEnv(input.spec.id), CI: "1", NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let outputBytes = 0;
  let output = "", errOutput = "", buffer = "", sequence = 0, active: string | null = null;
  let failure: Error | null = null, exited = false, ending = false, activityBytes = 0;
  const completed = new Set<string>();
  type Reply = { thread?: { id: string }; turn?: { id: string }; turnId?: string };
  const pending = new Map<number, { resolve(value: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const stop = () => {
    if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* already exited */ } }
    child.kill("SIGKILL");
  };
  const fail = (error: Error) => {
    failure ??= error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear(); wake.wake();
  };
  const abort = () => { fail(new Error("Execution stopped.")); stop(); };
  input.signal?.addEventListener("abort", abort, { once: true });
  // Stopped only when Codex goes quiet or runs past the overall cap; both are
  // paused while a person decides on an approval request.
  const deadline = new RunWatch(runLimits(), reason => { fail(new Error(deadline.describe(reason))); stop(); });
  const approvals = input.permissions ? "on-request" : "never";
  const approve = async (id: number, method: string, params: ApprovalParams) => {
    const request = describeCodexApproval(method, params);
    if (!request || !input.permissions) { write({ id, error: { code: -32601, message: "No one can approve this request. Stay within the workspace sandbox." } }); return; }
    try {
      const answer = await deadline.hold(() => input.permissions!(request));
      write({ id, result: codexApprovalResult(method, params, answer.allow, answer.always) });
    } catch { write({ id, result: codexApprovalResult(method, params, false, false) }); }
  };
  const off = input.inputs?.subscribe(() => wake.wake());
  const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  const rpc = (method: string, params: object): Promise<Reply> => new Promise((resolve, reject) => {
    if (failure || exited) { reject(failure ?? new Error("Agent disconnected.")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); const error = new Error(`${method}: agent acknowledgement timed out.`); reject(error); fail(error); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    write({ id, method, params });
  });
  child.stdin.on("error", fail);
  child.on("error", fail);
  const closed = new Promise<void>(resolve => child.once("close", () => { exited = true; if (!ending) fail(new Error("Agent disconnected before completing the chat.")); resolve(); }));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => {
    deadline.activity();
    errOutput = keepTail(errOutput + text, 256_000);
    if (outputBytes < 64 * 1024 * 1024) input.onEvent({ t: "err", d: text.slice(0, 16000) });
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    // Any frame (reasoning, a command's output, a plan update) is a sign of life.
    deadline.activity();
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) { fail(new Error("Agent protocol frame exceeds the limit.")); stop(); return; }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let frame: { id?: number; method?: string; result?: Reply; error?: { message: string }; params?: { delta?: string; turn?: { id: string; status: string; error?: { message: string } }; item?: { type: string; command?: string } } };
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.id != null && !frame.method) {
        const request = pending.get(frame.id);
        if (request) { pending.delete(frame.id); clearTimeout(request.timer); if (frame.error) request.reject(new Error(frame.error.message)); else request.resolve(frame.result ?? {}); }
        continue;
      }
      // Approval requests are relayed to the chat; anything else is refused.
      if (frame.id != null && frame.method) { void approve(frame.id, frame.method, (frame.params ?? {}) as ApprovalParams); continue; }
      const params = frame.params;
      if (frame.method === "item/agentMessage/delta" && params?.delta) {
        // The reply's end is kept; past 64 MB live output pauses, and Codex keeps working.
        output = keepTail(output + params.delta, 2 * 1024 * 1024);
        outputBytes += Buffer.byteLength(params.delta);
        if (outputBytes <= 64 * 1024 * 1024) input.onEvent({ t: "out", d: params.delta });
      } else if (frame.method === "item/started" && params?.item && activityBytes < 8 * 1024 * 1024) {
        const text = params.item.command ?? params.item.type;
        activityBytes += text.length; input.onEvent({ t: "act", d: text.slice(0, 16000) });
      } else if (frame.method === "turn/completed" && params?.turn) {
        completed.add(params.turn.id);
        wake.wake();
        if (active === params.turn.id) active = null;
        if (params.turn.status !== "completed") fail(new Error(params.turn.error?.message ?? `Agent turn ${params.turn.status}.`));
      }
    }
  });
  let claimed: string | null = null;
  try {
    if (input.signal?.aborted) abort();
    await rpc("initialize", { clientInfo: { name: "multicode-ai", title: "Multicode AI", version: "0.1.0" } });
    write({ method: "initialized", params: {} });
    // The chat's own Codex thread: resumed when this computer has it, so Codex
    // remembers earlier turns; otherwise a new one, kept on disk for next time.
    const settings = { cwd: input.cwd, model: input.model, approvalPolicy: approvals, sandbox: "workspace-write",
      ...(input.tools?.codexConfig ? { config: input.tools.codexConfig } : {}) };
    let threadId: string | null = null;
    let prompt = input.prompt;
    if (input.session?.previous) {
      try {
        const resumed = await rpc("thread/resume", { threadId: input.session.previous, ...settings });
        threadId = resumed.thread?.id ?? input.session.previous;
        prompt = input.session.resumePrompt ?? input.prompt;
      } catch (cause) {
        if (failure || exited) throw cause;
        input.onEvent({ t: "notice", message: "Started a new session with the AI tool: the chat's earlier one isn't on this computer. It has the conversation so far." });
      }
    }
    if (!threadId) {
      const thread = await rpc("thread/start", { ...settings, ephemeral: !input.session });
      if (!thread.thread?.id) throw new Error("Agent did not create a thread.");
      threadId = thread.thread.id;
    }
    input.session?.save(threadId);
    const start = async (text: string) => {
      const reply = await rpc("turn/start", { threadId, cwd: input.cwd, model: input.model, effort: input.effort, approvalPolicy: approvals,
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: false }, input: [{ type: "text", text }] });
      if (!reply.turn?.id) throw new Error("Agent did not create a turn.");
      active = completed.has(reply.turn.id) ? null : reply.turn.id;
    };
    await start(prompt);
    for (;;) {
      if (failure) throw failure;
      const revision = wake.version();
      const wasActive = !!active;
      const message = await input.inputs?.claim(!wasActive);
      if (message) {
        claimed = message.id;
        if (active) {
          const expectedTurnId = active;
          try { await rpc("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text: message.body }] }); }
          catch (cause) {
            // Retry only a definite rejection for an already completed turn.
            if (completed.has(expectedTurnId) && /no active turn|not active|turn.*mismatch/i.test(String(cause)) && !failure) await start(message.body);
            else throw cause;
          }
        } else await start(message.body);
        await input.inputs!.acknowledge(message.id);
        claimed = null;
        continue;
      }
      if (!active) { if (wasActive) continue; break; }
      await wake.wait(revision, input.signal);
    }
    return { code: 0, output, errOutput, ms: Date.now() - started };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (claimed) await input.inputs?.uncertain(claimed, "Delivery could not be confirmed; inspect the agent output before sending again.").catch(() => {});
    input.onEvent({ t: "err", d: message });
    return { code: 1, output, errOutput: `${errOutput}\n${message}`, ms: Date.now() - started };
  } finally {
    ending = true; off?.(); deadline.clear(); input.signal?.removeEventListener("abort", abort);
    stop(); await closed;
  }
}
