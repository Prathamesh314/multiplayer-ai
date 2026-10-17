import type { AgentAuth, AgentsResponse, AgentStatus } from "./catalog";
import type { AiRunEvent } from "../../api/ai/run/route";
import type { ForkableRunsResponse } from "../../api/sessions/[id]/forkable-runs/route";
import type {
  MentionRoomDTO,
  MentionTargetsResponse,
} from "../../api/sessions/[id]/mention-targets/route";

export type { AgentAuth, AgentStatus, AgentsResponse };
export type { ForkableRun } from "./memory";
export type { MentionRoomDTO };

export async function fetchAgents(refresh = false): Promise<AgentsResponse> {
  const response = await fetch(`/api/ai/agents${refresh ? "?refresh=1" : ""}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error("We couldn’t check your AI tools. Check your internet connection and try again.");
  return (await response.json()) as AgentsResponse;
}


/** Candidate source chats for "import context from…" in this room. */
export async function fetchForkableRuns(sessionId: string): Promise<ForkableRunsResponse> {
  const response = await fetch(`/api/sessions/${sessionId}/forkable-runs`, { cache: "no-store" });
  if (!response.ok) return { runs: [] };
  return (await response.json()) as ForkableRunsResponse;
}

/** Every visible room in this room's project (with its chats), for the @ picker. */
export async function fetchMentionTargets(sessionId: string): Promise<MentionRoomDTO[]> {
  const response = await fetch(`/api/sessions/${sessionId}/mention-targets`, { cache: "no-store" });
  if (!response.ok) return [];
  return ((await response.json()) as MentionTargetsResponse).rooms;
}

export type RunHandle = { cancel: () => void };

/**
 * Streams one agent run. Output arrives as it is produced — these tools think
 * for tens of seconds, so buffering the whole run would look like a hang.
 */
export function runAgent(
  input: {
    sessionId: string;
    agentId: string;
    prompt: string;
    runId?: string;
    controlVersion?: number;
    title?: string;
    model?: string;
    effort?: string;
    forkFromRunId?: string;
    /** Run ids of chats referenced with `@room/<run-id>` in the prompt. */
    contextRefs?: string[];
    /** Which room repo a new chat works on; omitted = the room's project fork. */
    repoId?: string;
    /** Open a new chat on its own branch, so it can run alongside others. */
    isolation?: "isolated";
    /** Uploaded attachments to send; they reach the agent as files in its worktree. */
    attachmentIds?: string[];
    /** Repository paths tagged with "@" in the prompt (lib/ai/file-mentions.ts). */
    fileRefs?: string[];
    /** Manual ("ask") or Auto approval for this chat. */
    permissionMode?: "ask" | "auto";
  },
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
        body: JSON.stringify({ ...input, turnId: crypto.randomUUID() }),
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
