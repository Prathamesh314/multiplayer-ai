/*
 * Spawning the agent CLI on this machine, the only place agents run: with
 * output caps, the shared catalog's stream decoding, and one-shot
 * discipline. What it deliberately lacks is everything durable:
 * no database, no events bus — output goes to the caller, who streams it
 * up the protocol and lets the server persist.
 *
 * The credential story is the whole point: the CLI runs exactly as if the
 * machine's owner typed it — their login, their subscription, their
 * rate limits. Nothing is injected and nothing is read back.
 */

import { RunWatch, keepTail, runLimits, type PermissionAsker } from "./permissions";
import { allowResponse, denyResponse, describeToolUse, errorResponse, isControlRequest, type CanUseTool, type ControlRequest } from "./claude-control";
import { assertAvailableModel } from "../app/lib/ai/model-discovery";
import { commandLine } from "../app/lib/ai/command";
import type { InputSource } from "./input-types";
import { runCodexSession } from "./codex-session";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentSpec } from "../app/lib/ai/catalog";
import { agentEnv } from "../app/lib/ai/env";
import type { AiRunEvent } from "../app/lib/ai/run-events";

/** The reply kept for the chat: its end (where the answer is) when a long session says more. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** What is streamed live; past it the agent keeps working and its reply's end is still kept. */
const MAX_LIVE_BYTES = 64 * 1024 * 1024;
/** Thinking and tool steps: an hours-long task takes thousands of steps. */
const MAX_THINK_BYTES = 8 * 1024 * 1024;
const MAX_ERR_BYTES = 256 * 1024;

export { keepTail };

export type LocalRunResult = {
  code: number | null;
  output: string;
  errOutput: string;
  ms: number;
};

/** Targets the process group so a helper the agent spawned dies with it. */
function kill(child: ReturnType<typeof spawn>): void {
  try {
    if (child.pid && process.platform === "win32") {
      // Windows has no process groups: end the agent and every command it started.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill("SIGKILL"));
      return;
    }
    if (!child.pid) { child.kill("SIGKILL"); return; }
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export type RunInput = {
  spec: AgentSpec;
  prompt: string;
  model?: string;
  effort?: string;
  cwd: string;
  onEvent: (event: AiRunEvent) => void;
  inputs?: InputSource;
  signal?: AbortSignal;
  /** Asks the chat before the agent uses a tool that needs permission. Absent: refused. */
  permissions?: PermissionAsker;
  /**
   * The chat's own session with the tool on this computer (runner/chat-sessions.ts):
   * resumed when there is one, so the agent remembers earlier turns; `save`
   * records the session this turn used.
   */
  session?: ChatSessionLink;
  /** Tool rules the chat always allows. */
  allowedTools?: string[];
  /** MCP servers and plugins for this run (runner/agent-tools.ts). */
  tools?: { args: string[]; codexConfig?: object };
};

export type ChatSessionLink = {
  /** The session to resume, if this chat has one here. */
  previous: string | null;
  /** The prompt without the conversation so far, for a resumed session (which remembers it). */
  resumePrompt?: string;
  save(sessionId: string): void;
};

/**
 * Tools whose sessions the runner resumes by a session id it chooses, with how
 * a resume that cannot work says so (then a new session starts instead).
 */
const SESSION_FLAGS: Record<string, { start: string; resume: string; missing: RegExp }> = {
  claude: { start: "--session-id", resume: "--resume", missing: /No conversation found|Failed to resume|Unable to load transcript/i },
  gemini: { start: "--session-id", resume: "--resume", missing: /Error resuming session|Invalid session identifier/i },
};

export async function runAgentLocally(input: RunInput): Promise<LocalRunResult> {
  await assertAvailableModel(input.spec, input.model, input.effort);
  if (input.spec.id === "codex" && input.inputs) return runCodexSession(input);
  // Each run is watched for silence and its overall length (RunWatch); this
  // is only the backstop for the whole sequence of queued follow-ups.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), runLimits().maxMs);
  deadline.unref?.();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try { return await runSequence({ ...input, signal }); } finally { clearTimeout(deadline); }
}

/**
 * One run in the chat's own session: resume it when there is one (with the
 * shorter prompt, as the tool remembers the rest), otherwise start a new one
 * with an id chosen here. A session that cannot be resumed on this computer
 * (gone, or from another one) is replaced by a new one with the full prompt;
 * any other failure is the run's own and is not retried.
 */
async function runInSession(input: RunInput, accepted?: () => Promise<void>): Promise<{ result: LocalRunResult; sessionId: string | null }> {
  const flags = SESSION_FLAGS[input.spec.id];
  const session = input.session;
  if (!flags || !session) return { result: await runOnce(input, accepted), sessionId: null };
  if (session.previous) {
    const resumed = await runOnce({ ...input, prompt: session.resumePrompt ?? input.prompt, sessionArgs: [flags.resume, session.previous] }, accepted);
    if (!flags.missing.test(resumed.errOutput) || input.signal?.aborted) {
      session.save(session.previous);
      return { result: resumed, sessionId: session.previous };
    }
    input.onEvent({ t: "notice", message: "Started a new session with the AI tool: the chat's earlier one isn't on this computer. It has the conversation so far." });
  }
  const id = randomUUID();
  const fresh = await runOnce({ ...input, sessionArgs: [flags.start, id] }, accepted);
  session.save(id);
  return { result: fresh, sessionId: id };
}

async function runSequence(input: RunInput): Promise<LocalRunResult> {
  const started = Date.now();
  const first = await runInSession(input);
  let result = first.result;
  // Follow-ups queued during the turn continue the same session, which remembers the turn.
  const sessionId = first.sessionId;
  let history = `Agent: ${result.output}`;
  try {
  while (result.code === 0 && input.inputs) {
    const next = await input.inputs.claim(true);
    if (!next) break;
    if (Date.now() - started >= runLimits().maxMs) {
      await input.inputs.uncertain(next.id, "Execution limit reached before delivery.");
      return { ...result, code: 1, errOutput: "Execution limit reached." };
    }
    let acknowledged = false;
    const deliver = async () => { await input.inputs!.acknowledge(next.id); acknowledged = true; };
    const followup = sessionId && SESSION_FLAGS[input.spec.id]
      ? await runOnce({ ...input, prompt: next.body, sessionArgs: [SESSION_FLAGS[input.spec.id].resume, sessionId] }, deliver)
      : await runOnce({ ...input, prompt: `${input.prompt}\n\nPrevious conversation:\n${history.slice(-64000)}\n\nAdditional user instruction (continue in the current workspace):\n${next.body}` }, deliver);
    if (!acknowledged) await input.inputs.uncertain(next.id, "Delivery could not be confirmed; inspect the output before sending again.").catch(() => {});
    history += `\nUser: ${next.body}\nAgent: ${followup.output}`;
    history = history.slice(-64000);
    result = { code: followup.code, output: keepTail(result.output + "\n\n" + followup.output, MAX_OUTPUT_BYTES), errOutput: keepTail(result.errOutput + followup.errOutput, MAX_ERR_BYTES), ms: Date.now() - started };
  }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    input.onEvent({ t: "err", d: message });
    result = { ...result, code: 1, errOutput: `${result.errOutput}\n${message}`, ms: Date.now() - started };
  }
  return result;
}

/** Windows starts a program with one command line of at most 32,767 characters. */
const WINDOWS_COMMAND_LINE_MAX = 32_767;

/** Its length once quoted the way Node passes arguments to a Windows program. */
export function windowsCommandLineLength(file: string, argv: string[]): number {
  return [file, ...argv].reduce((total, arg) => {
    const quotes = /[\s"]/.test(arg) || arg === "" ? 2 : 0;
    const escapes = (arg.match(/"/g)?.length ?? 0) + (arg.match(/\\+(?="|$)/g)?.join("").length ?? 0);
    return total + arg.length + quotes + escapes + 1;
  }, 0);
}

async function runOnce(input: RunInput & { sessionArgs?: string[] }, accepted?: () => Promise<void>): Promise<LocalRunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = [...(input.tools?.args ?? []), ...(input.sessionArgs ?? []), ...input.spec.promptArgs(input.prompt, {
      model: input.model,
      effort: input.effort,
      allowedTools: input.allowedTools,
    })];
    const interactive = !!input.spec.stdinPrompt;
    const parser = input.spec.createStreamParser?.() ?? null;

    let child: ReturnType<typeof spawn>;
    try {
      // On Windows the npm launcher's own entry point, without a shell (lib/ai/command.ts).
      const [file, argv] = commandLine(input.spec.bin, args);
      if (process.platform === "win32" && windowsCommandLineLength(file, argv) > WINDOWS_COMMAND_LINE_MAX) {
        throw new Error(`${input.spec.name} takes its prompt on the command line, which Windows limits to 32,767 characters, and this one is longer (it includes the conversation so far). Start a new chat, or use Claude Code or Codex, which have no such limit.`);
      }
      child = spawn(file, argv, {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
        env: { ...agentEnv(input.spec.id), CI: "1", NO_COLOR: "1" },
        stdio: [interactive ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      input.onEvent({ t: "err", d: `${message}\n` });
      resolve({ code: null, output: "", errOutput: message, ms: 0 });
      return;
    }

    let receipt = Promise.resolve();
    child.once("spawn", () => { receipt = accepted?.().catch(cause => { input.onEvent({ t: "err", d: String(cause) }); kill(child); throw cause; }) ?? Promise.resolve(); void receipt.catch(() => {}); });
    const abort = () => kill(child);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    let parserFailed = false;
    let liveBytes = 0;
    let liveCapped = false;
    let thinkBytes = 0;
    let outBuf = "";
    let errBuf = "";

    // Stopped only when the agent goes quiet or runs past the overall cap;
    // both are paused while a person decides on a tool request.
    const watch = new RunWatch(runLimits(), reason => {
      input.onEvent({ t: "notice", message: watch.describe(reason) });
      kill(child);
    });
    const live = (event: AiRunEvent & { d: string }) => {
      liveBytes += Buffer.byteLength(event.d);
      if (liveBytes <= MAX_LIVE_BYTES) { input.onEvent(event); return; }
      if (liveCapped) return;
      liveCapped = true;
      input.onEvent({ t: "notice", message: "This reply is very long, so live output is paused. The agent keeps working, and the end of its reply is kept." });
    };
    const send = (message: unknown) => { if (child.stdin && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`); };
    if (interactive) {
      child.stdin?.on("error", () => { /* the agent exited; its close event reports it */ });
      send(input.spec.stdinPrompt!(input.prompt));
    }
    /** A control request from the agent: relay tool permission requests to the chat. */
    const control = async (message: ControlRequest) => {
      if (message.request.subtype !== "can_use_tool" || !message.request.tool_name) {
        send(errorResponse(message.request_id, `Unsupported request: ${message.request.subtype}`));
        return;
      }
      const request = message.request as CanUseTool;
      if (!input.permissions) {
        send(denyResponse(message.request_id, "No one can approve tools for this run. Work within the repository, or ask the user to update the desktop app."));
        return;
      }
      try {
        const answer = await watch.hold(() => input.permissions!(describeToolUse(request)));
        send(answer.allow ? allowResponse(message.request_id, request) : denyResponse(message.request_id, "The user declined this tool request in the chat."));
      } catch (cause) {
        send(denyResponse(message.request_id, `The request could not reach the user: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    };

    const emitReply = (text: string) => {
      watch.activity();
      live({ t: "out", d: text });
      outBuf = keepTail(outBuf + text, MAX_OUTPUT_BYTES);
    };
    const emitThinking = (text: string) => {
      watch.activity();
      if (thinkBytes >= MAX_THINK_BYTES) return;
      thinkBytes += Buffer.byteLength(text);
      input.onEvent({ t: "think", d: text });
    };
    const emitActivity = (text: string) => {
      watch.activity();
      if (thinkBytes >= MAX_THINK_BYTES) return;
      thinkBytes += Buffer.byteLength(text);
      input.onEvent({ t: "act", d: text });
    };
    const emitErr = (chunk: string) => {
      watch.activity();
      live({ t: "err", d: chunk });
      errBuf = keepTail(errBuf + chunk, MAX_ERR_BYTES);
    };

    // stdout is either JSON events to decode (parser set) or the reply
    // verbatim. JSON is newline-delimited, so it is buffered into whole lines;
    // a trailing partial line is left for the next chunk.
    let lineBuf = "";
    const onStdout = (chunk: string) => {
      // Any output is a sign of life, even a frame that shows nothing.
      watch.activity();
      if (!parser) {
        emitReply(chunk);
        return;
      }
      lineBuf += chunk;
      let newline;
      while ((newline = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, newline);
        lineBuf = lineBuf.slice(newline + 1);
        if (!line.trim()) continue;
        if (interactive && line.includes('"control_')) {
          let message: unknown = null;
          try { message = JSON.parse(line); } catch { /* not a control frame */ }
          if (isControlRequest(message)) { void control(message); continue; }
          if ((message as { type?: string } | null)?.type === "control_cancel_request") continue;
        }
        // The answer is complete; closing stdin lets the session end.
        if (interactive && line.includes('"result"')) {
          try { if ((JSON.parse(line) as { type?: string }).type === "result") child.stdin?.end(); } catch { /* not JSON */ }
        }
        for (const piece of parser.push(line)) {
          if (piece.kind === "reply") emitReply(piece.text);
          else if (piece.kind === "thinking") emitThinking(piece.text);
          else if (piece.kind === "error") { parserFailed = true; emitErr(piece.text); kill(child); }
          else emitActivity(piece.text);
        }
      }
    };

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onStdout);
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", emitErr);
    }

    child.on("error", (cause) => emitErr(`${cause.message}\n`));
    child.on("close", async (code) => {
      input.signal?.removeEventListener("abort", abort);
      try { await receipt; } catch { code = 1; }
      if (parserFailed) code = 1;
      watch.clear();
      resolve({ code, output: outBuf, errOutput: errBuf, ms: Date.now() - startedAt });
    });
  });
}
