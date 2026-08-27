import type { AgentRun, AgentRunMessage, RunResponse, RunsResponse } from "./runs";

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
