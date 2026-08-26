import type { AgentsResponse, AgentStatus } from "./catalog";
import type { AiRunEvent } from "../../api/ai/run/route";

export type { AgentStatus, AgentsResponse };

export async function fetchAgents(refresh = false): Promise<AgentsResponse> {
  const response = await fetch(`/api/ai/agents${refresh ? "?refresh=1" : ""}`, {
    cache: "no-store",
  });
  if (!response.ok) return { agents: [], canRun: false, reason: null };
  return (await response.json()) as AgentsResponse;
}

export type RunHandle = { cancel: () => void };

/**
 * Streams one agent run. Output arrives as it is produced — these tools think
 * for tens of seconds, so buffering the whole run would look like a hang.
 */
export function runAgent(
  input: { sessionId: string; agentId: string; prompt: string; runId?: string; title?: string },
  handlers: {
    onEvent: (event: AiRunEvent) => void;
    onError: (message: string) => void;
    onDone: () => void;
  },
): RunHandle {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch("/api/ai/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        handlers.onError(body?.error ?? "Could not start the agent.");
        handlers.onDone();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // NDJSON: one event per line, and the tail may be a partial line.
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            handlers.onEvent(JSON.parse(line) as AiRunEvent);
          } catch {
            // A truncated frame is not worth failing the run over.
          }
        }
      }
    } catch (cause) {
      if ((cause as Error)?.name !== "AbortError") {
        handlers.onError(cause instanceof Error ? cause.message : "The agent run failed.");
      }
    } finally {
      handlers.onDone();
    }
  })();

  return { cancel: () => controller.abort() };
}
