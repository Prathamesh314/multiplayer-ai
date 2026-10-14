import type { Checkpoint } from "../app/lib/runner/checkpoint-types";
import { detectAgents } from "../app/lib/ai/detect";
import { readSignals } from "./signals";
import type { QueuedInput } from "./input-types";
/*
 * The runner's half of the protocol (docs/local-execution.md §3.3): five
 * plain HTTP calls against the control plane, authenticated by the device
 * token. Types are imported from the server modules so the two halves cannot
 * drift — they are type-only imports, nothing server-side executes here.
 */

import type { AgentRunJob, AiRunEvent } from "../app/lib/ai/run-events";
import type { ClaimResponse } from "../app/api/runner/claim/route";
import type { PairResponse } from "../app/api/runner/pair/route";
import type { RunnerCompleteRequest } from "../app/api/runner/runs/[runId]/complete/route";
import type { RunnerWorkspacesResponse } from "../app/api/runner/workspaces/route";

export class RunnerHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs = 1000) { super(message); }
}

export function permanentRunnerFailure(error: unknown): boolean {
  return error instanceof RunnerHttpError && error.status < 500 && error.status !== 429 ||
    error instanceof Error && error.message.includes('re-pair');
}

export class RunnerApi {
  private inventory = "";
  constructor(
    private readonly server: string,
    private readonly token: string,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.server}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(45_000),
      redirect: "error",
    });
    if (response.status === 401) {
      throw new Error("This device was revoked or the token is stale — re-pair with `multicode-ai-runner pair`.");
    }
    if (!response.ok) {
      const parsed = (await response.json().catch(() => null)) as { error?: string } | null;
      const seconds = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(30_000, seconds * 1000) : 1000;
      throw new RunnerHttpError(parsed?.error ?? `${path} failed with ${response.status}`, response.status, retryAfterMs);
    }
    return (await response.json()) as T;
  }

  async heartbeat(onlyChanged = false): Promise<void> {
    const agents = await detectAgents();
    const available = agents.filter(agent => agent.installed && agent.auth?.loggedIn !== false);
    const body = { version: "2", supportsInputs: true, supportsIsolatedChats: true, agentIds: available.map(agent => agent.id), modelCatalog: Object.fromEntries(available.filter(agent => agent.models).map(agent => [agent.id, agent.models])) };
    // Timestamps change when the CLI cache is refreshed; they are not inventory changes.
    const signature = JSON.stringify(body, (key, value) => ["checkedAt", "refreshedAt"].includes(key) ? undefined : value);
    if (onlyChanged && this.inventory === signature) return;
    await this.post("/api/runner/heartbeat", body);
    this.inventory = signature;
  }

  async signals(signal: AbortSignal, onEvent: (type: string, data: unknown) => void): Promise<void> {
    const response = await fetch(`${this.server}/api/runner/events`, { headers: { authorization: `Bearer ${this.token}` }, signal, redirect: "error" });
    if (response.status === 401) throw new Error("This device was revoked — re-pair with multicode-ai-runner pair.");
    if (!response.ok) throw new Error(`Runner live connection failed (${response.status}). Update the server and runner together.`);
    await readSignals(response, onEvent);
  }

  async input(turnId: string, action: { kind: "claim"; claimId: string; closeIfEmpty?: boolean } | { kind:"ack"|"uncertain"; id:string; error?:string }): Promise<QueuedInput | null> {
    // Every action has a stable identity. Retrying a lost acknowledgement never
    // resends text to the agent, and retrying a claim returns the same input.
    let failure: unknown;
    for(let attempt=0;attempt<3;attempt++) {
      try { return (await this.post<{input:QueuedInput|null}>(`/api/runner/runs/${encodeURIComponent(turnId)}/inputs`,action)).input; }
      catch(error) {
        failure=error;
        if (permanentRunnerFailure(error)) throw error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, error instanceof RunnerHttpError && error.status === 429 ? error.retryAfterMs : 250 * (attempt + 1)));
      }
    }
    throw failure;
  }

  /** Long-poll for the next job addressed to this device's user. */
  async claim(waitMs: number): Promise<AgentRunJob | null> {
    const body = await this.post<ClaimResponse>("/api/runner/claim", { waitMs, version: "2" });
    return body.job;
  }

  /** This device's user and their finished parallel chats, whose worktrees may be pruned. */
  async workspaces(): Promise<RunnerWorkspacesResponse> {
    return this.post<RunnerWorkspacesResponse>("/api/runner/workspaces", {});
  }

  async postEvents(runId: string, events: AiRunEvent[], sequence?: number): Promise<void> {
    const result = await this.post<{ acknowledged?: number }>(`/api/runner/runs/${encodeURIComponent(runId)}/events`, { events, sequence });
    if (sequence !== undefined && result.acknowledged !== sequence) throw new Error("Server did not durably acknowledge the activity batch. Update the server.");
  }

  async checkpoint(snapshot: Checkpoint): Promise<void> {
    const result = await this.post<{ acknowledged: string }>(`/api/runner/runs/${snapshot.turnId}/checkpoints`, snapshot);
    if (result.acknowledged !== snapshot.snapshotSha) throw new Error("Checkpoint was not acknowledged.");
  }

  async complete(runId: string, report: RunnerCompleteRequest): Promise<void> {
    await this.post(`/api/runner/runs/${encodeURIComponent(runId)}/complete`, report);
  }
}

/** Exchange a pairing code for a device token — the one unauthenticated call. */
export async function pairDevice(input: {
  server: string;
  code: string;
  name: string;
}): Promise<{ token: string; deviceId: string }> {
  const response = await fetch(`${input.server}/api/runner/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: input.code,
      name: input.name,
      platform: process.platform,
      version: "0.1.0",
    }),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  const parsed = (await response.json().catch(() => null)) as
    | (PairResponse & { error?: string })
    | null;
  if (!response.ok || !parsed?.token) {
    throw new Error(parsed?.error ?? "Pairing failed.");
  }
  return { token: parsed.token, deviceId: parsed.device.id };
}
