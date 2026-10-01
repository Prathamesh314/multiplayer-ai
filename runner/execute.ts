/*
 * Spawning the agent CLI on this machine — the runner-side twin of the
 * server executor's process core (app/lib/ai/execute.ts), with the same
 * caps, the same stream decoding (the shared catalog parser), and the same
 * one-shot discipline. What it deliberately lacks is everything durable:
 * no database, no events bus — output goes to the caller, who streams it
 * up the protocol and lets the server persist.
 *
 * The credential story is the whole point: the CLI runs exactly as if the
 * machine's owner typed it — their login, their subscription, their
 * rate limits. Nothing is injected and nothing is read back.
 */

import { assertAvailableModel } from "../app/lib/ai/model-discovery";
import type { InputSource } from "./input-types";
import { runCodexSession } from "./codex-session";
import { spawn } from "node:child_process";
import type { AgentSpec } from "../app/lib/ai/catalog";
import { agentEnv } from "../app/lib/ai/env";
import type { AiRunEvent } from "../app/lib/ai/run-events";

const MAX_RUN_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_THINK_BYTES = 256 * 1024;

export type LocalRunResult = {
  code: number | null;
  output: string;
  errOutput: string;
  ms: number;
};

/** Targets the process group so a helper the agent spawned dies with it. */
function kill(child: ReturnType<typeof spawn>): void {
  try {
    if (!child.pid || process.platform === "win32") { child.kill("SIGKILL"); return; }
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
};

export async function runAgentLocally(input: RunInput): Promise<LocalRunResult> {
  await assertAvailableModel(input.spec, input.model, input.effort);
  if (input.spec.id === "codex" && input.inputs) return runCodexSession(input);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), MAX_RUN_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  let bytes = 0;
  const limited = { ...input, signal, onEvent: (event: AiRunEvent) => {
    if (event.t === "out" || event.t === "err") {
      bytes += Buffer.byteLength(event.d);
      if (bytes > MAX_OUTPUT_BYTES) controller.abort();
    }
    input.onEvent(event);
  } };
  try { return await runSequence(limited); } finally { clearTimeout(deadline); }
}

async function runSequence(input: RunInput): Promise<LocalRunResult> {
  const started = Date.now();
  let result = await runOnce(input);
  let history = `Agent: ${result.output}`;
  try {
  while (result.code === 0 && input.inputs) {
    const next = await input.inputs.claim(true);
    if (!next) break;
    if (Date.now() - started >= MAX_RUN_MS || Buffer.byteLength(result.output) >= MAX_OUTPUT_BYTES) {
      await input.inputs.uncertain(next.id, "Execution limit reached before delivery.");
      return { ...result, code: 1, errOutput: "Execution limit reached." };
    }
    let acknowledged = false;
    const followup = await runOnce({ ...input, prompt: `${input.prompt}\n\nPrevious conversation:\n${history.slice(-64000)}\n\nAdditional user instruction (continue in the current workspace):\n${next.body}` }, async () => {
      await input.inputs!.acknowledge(next.id); acknowledged = true;
    });
    if (!acknowledged) await input.inputs.uncertain(next.id, "Delivery could not be confirmed; inspect the output before sending again.").catch(() => {});
    history += `\nUser: ${next.body}\nAgent: ${followup.output}`;
    history = history.slice(-64000);
    result = { code: followup.code, output: result.output + "\n\n" + followup.output, errOutput: result.errOutput + followup.errOutput, ms: Date.now() - started };
  }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    input.onEvent({ t: "err", d: message });
    result = { ...result, code: 1, errOutput: `${result.errOutput}\n${message}`, ms: Date.now() - started };
  }
  return result;
}

async function runOnce(input: RunInput, accepted?: () => Promise<void>): Promise<LocalRunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = input.spec.promptArgs(input.prompt, {
      model: input.model,
      effort: input.effort,
    });
    const parser = input.spec.createStreamParser?.() ?? null;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.spec.bin, args, {
        cwd: input.cwd,
        detached: process.platform !== "win32",
        env: { ...agentEnv(input.spec.id), CI: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
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
    let bytes = 0;
    let thinkBytes = 0;
    let outBuf = "";
    let errBuf = "";

    const deadline = setTimeout(() => {
      input.onEvent({ t: "notice", message: `Stopped after ${MAX_RUN_MS / 60_000} minutes.` });
      kill(child);
    }, MAX_RUN_MS);
    deadline.unref?.();

    const emitReply = (text: string) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      bytes += Buffer.byteLength(text);
      input.onEvent({ t: "out", d: text });
      outBuf += text;
      if (bytes >= MAX_OUTPUT_BYTES) {
        input.onEvent({ t: "notice", message: "Output limit reached — the run was stopped." });
        kill(child);
      }
    };
    const emitThinking = (text: string) => {
      if (thinkBytes >= MAX_THINK_BYTES) return;
      thinkBytes += Buffer.byteLength(text);
      input.onEvent({ t: "think", d: text });
    };
    const emitActivity = (text: string) => {
      if (thinkBytes >= MAX_THINK_BYTES) return;
      thinkBytes += Buffer.byteLength(text);
      input.onEvent({ t: "act", d: text });
    };
    const emitErr = (chunk: string) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      bytes += Buffer.byteLength(chunk);
      input.onEvent({ t: "err", d: chunk });
      errBuf += chunk;
    };

    // stdout is either JSON events to decode (parser set) or the reply
    // verbatim. JSON is newline-delimited, so it is buffered into whole lines;
    // a trailing partial line is left for the next chunk.
    let lineBuf = "";
    const onStdout = (chunk: string) => {
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
      clearTimeout(deadline);
      resolve({ code, output: outBuf, errOutput: errBuf, ms: Date.now() - startedAt });
    });
  });
}
