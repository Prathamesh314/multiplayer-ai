import { spawn } from "node:child_process";
import { agentEnv } from "../app/lib/ai/env";
import { WakeSignal } from "./signals";
import type { RunInput, LocalRunResult } from "./execute";

/** Codex's app-server keeps one thread alive and accepts native turn/steer input. */
export async function runCodexSession(input: RunInput): Promise<LocalRunResult> {
  const started = Date.now(), wake = new WakeSignal();
  const child = spawn(input.spec.bin, ["app-server"], {
    cwd: input.cwd, detached: process.platform !== "win32",
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
  const deadline = setTimeout(() => { fail(new Error("Stopped after 10 minutes.")); stop(); }, 600_000);
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
    if (errOutput.length < 256_000) { errOutput += text.slice(0, 256_000 - errOutput.length); input.onEvent({ t: "err", d: text.slice(0, 16000) }); }
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
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
      // This app does not have an approval UI for CLI requests. Never auto-approve.
      if (frame.id != null && frame.method) { write({ id: frame.id, error: { code: -32601, message: "Interactive approvals are unavailable. Stay within the workspace sandbox." } }); continue; }
      const params = frame.params;
      if (frame.method === "item/agentMessage/delta" && params?.delta) {
        output += params.delta; input.onEvent({ t: "out", d: params.delta });
        outputBytes += Buffer.byteLength(params.delta);
        if (outputBytes > 2 * 1024 * 1024) { fail(new Error("Output limit reached.")); stop(); }
      } else if (frame.method === "item/started" && params?.item && activityBytes < 256_000) {
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
    const thread = await rpc("thread/start", { cwd: input.cwd, model: input.model, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true });
    if (!thread.thread?.id) throw new Error("Agent did not create a thread.");
    const threadId = thread.thread.id;
    const start = async (text: string) => {
      const reply = await rpc("turn/start", { threadId, cwd: input.cwd, model: input.model, effort: input.effort, approvalPolicy: "never",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [input.cwd], networkAccess: false }, input: [{ type: "text", text }] });
      if (!reply.turn?.id) throw new Error("Agent did not create a turn.");
      active = completed.has(reply.turn.id) ? null : reply.turn.id;
    };
    await start(input.prompt);
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
    ending = true; off?.(); clearTimeout(deadline); input.signal?.removeEventListener("abort", abort);
    stop(); await closed;
  }
}
