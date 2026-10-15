import type { AgentRun, AgentRunMessage, RunResponse, RunsResponse } from "./runs";
import type {
  ChatBranchActionRequest, ChatBranchActionResponse, ChatBranchResponse, ChatFileDiffResponse,
} from "../../api/sessions/[id]/runs/[runId]/branch/route";

export type { ChatBranchResponse as ChatBranch, ChatBranchActionResponse as ChatBranchOutcome };

async function readError(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

const base = (sessionId: string) => `/api/sessions/${encodeURIComponent(sessionId)}/runs`;

export async function listRuns(sessionId: string): Promise<AgentRun[]> {
  const response = await fetch(base(sessionId), { cache: "no-store" });
  if (!response.ok) return [];
  return ((await response.json()) as RunsResponse).runs;
}

export async function fetchRun(
  sessionId: string,
  runId: string,
  afterSeq = 0,
): Promise<{ run: AgentRun; messages: AgentRunMessage[] }> {
  const query = afterSeq > 0 ? `?after=${afterSeq}` : "";
  const response = await fetch(`${base(sessionId)}/${encodeURIComponent(runId)}${query}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(await readError(response, "Could not load that run."));
  return (await response.json()) as RunResponse;
}

/** Rename a run (allowed only for the run's starter). */
export async function renameRun(sessionId: string, runId: string, title: string): Promise<void> {
  const response = await fetch(`${base(sessionId)}/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not rename that run."));
}

/** Archive or restore a run (allowed only for the run's starter). */
export async function archiveRun(
  sessionId: string,
  runId: string,
  archived: boolean,
): Promise<void> {
  const response = await fetch(`${base(sessionId)}/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not archive that run."));
}

/** Watch (viewer) or co-drive (editor) an existing run. */
export async function joinRun(
  sessionId: string,
  runId: string,
  role: "editor" | "viewer",
): Promise<void> {
  const response = await fetch(`${base(sessionId)}/${encodeURIComponent(runId)}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
  if (!response.ok) throw new Error(await readError(response, "Could not join that run."));
}

export async function leaveRun(sessionId: string, runId: string): Promise<void> {
  await fetch(`${base(sessionId)}/${encodeURIComponent(runId)}/join`, { method: "DELETE" });
}

const branchUrl = (sessionId: string, runId: string) => `${base(sessionId)}/${encodeURIComponent(runId)}/branch`;

/** A parallel chat's proposal against the room: heads, ahead/behind and changed files. */
export async function fetchChatBranch(sessionId: string, runId: string): Promise<ChatBranchResponse> {
  const response = await fetch(branchUrl(sessionId, runId), { cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, "Could not load this chat's changes."));
  return (await response.json()) as ChatBranchResponse;
}

/** One file's diff in a parallel chat's proposal. */
export async function fetchChatFileDiff(sessionId: string, runId: string, path: string): Promise<string> {
  const response = await fetch(`${branchUrl(sessionId, runId)}?path=${encodeURIComponent(path)}`, { cache: "no-store" });
  if (!response.ok) throw new Error(await readError(response, "Could not load that file's changes."));
  return ((await response.json()) as ChatFileDiffResponse).diff;
}

/**
 * Merge, update, discard or reopen a parallel chat. A conflict is an answer,
 * not an error: it resolves with `{ ok: false, reason, files }`.
 */
export async function chatBranchAction(sessionId: string, runId: string, action: ChatBranchActionRequest): Promise<ChatBranchActionResponse> {
  const response = await fetch(branchUrl(sessionId, runId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });
  if (response.status === 409) {
    const body = (await response.clone().json().catch(() => null)) as ChatBranchActionResponse | { error?: string } | null;
    if (body && "ok" in body && body.ok === false) return body;
  }
  if (!response.ok) throw new Error(await readError(response, "That didn’t work. Refresh and try again."));
  return (await response.json()) as ChatBranchActionResponse;
}
