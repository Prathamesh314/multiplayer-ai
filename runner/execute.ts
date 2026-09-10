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
    process.kill(-(child.pid ?? 0), "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function runAgentLocally(input: {
  spec: AgentSpec;
  prompt: string;
  model?: string;
  effort?: string;
  cwd: string;
  onEvent: (event: AiRunEvent) => void;
}): Promise<LocalRunResult> {
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
        env: { ...agentEnv(), CI: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      input.onEvent({ t: "err", d: `${message}\n` });
      resolve({ code: null, output: "", errOutput: message, ms: 0 });
      return;
    }

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
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolve({ code, output: outBuf, errOutput: errBuf, ms: Date.now() - startedAt });
    });
  });
}
