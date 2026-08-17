import type { TerminalEvent, TerminalStatus } from "./protocol";

export async function fetchTerminalStatus(): Promise<TerminalStatus> {
  const response = await fetch("/api/terminal", { cache: "no-store" });
  if (!response.ok) throw new Error(`Terminal status failed (${response.status})`);
  return (await response.json()) as TerminalStatus;
}

export async function interruptRun(runId: string): Promise<void> {
  await fetch("/api/terminal/interrupt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  });
}

/**
 * Streams one command's output. Resolves when the run ends; `onEvent` fires for
 * every line the server emits.
 */
export async function runCommand(options: {
  command: string;
  cwd: string;
  runId: string;
  signal?: AbortSignal;
  onEvent: (event: TerminalEvent) => void;
}): Promise<void> {
  const response = await fetch("/api/terminal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: options.command,
      cwd: options.cwd,
      runId: options.runId,
    }),
    signal: options.signal,
  });

  if (!response.ok || !response.body) {
    const message = await response
      .json()
      .then((body: { error?: string }) => body.error)
      .catch(() => undefined);
    throw new Error(message ?? `The terminal request failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    buffered += decoder.decode(value, { stream: true });

    // NDJSON: a chunk can split a line, so keep the tail for the next read.
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) options.onEvent(JSON.parse(line) as TerminalEvent);
      newline = buffered.indexOf("\n");
    }
  }

  if (buffered.trim()) options.onEvent(JSON.parse(buffered) as TerminalEvent);
}
