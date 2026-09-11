import { detectAgents } from "../app/lib/ai/detect";
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

export class RunnerApi {
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
      throw new Error("This device was revoked or the token is stale — re-pair with `runner pair`.");
    }
    if (!response.ok) {
      const parsed = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(parsed?.error ?? `${path} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async heartbeat(): Promise<void> {
    const agents = await detectAgents();
    const available = agents.filter(agent => agent.installed && agent.auth?.loggedIn !== false);
    await this.post("/api/runner/heartbeat", { version: "2", agentIds: available.map(agent => agent.id), modelCatalog: Object.fromEntries(available.filter(agent => agent.models).map(agent => [agent.id, agent.models])) });
  }

  /** Long-poll for the next job addressed to this device's user. */
  async claim(waitMs: number): Promise<AgentRunJob | null> {
    const body = await this.post<ClaimResponse>("/api/runner/claim", { waitMs, version: "2" });
    return body.job;
  }

  async postEvents(runId: string, events: AiRunEvent[]): Promise<void> {
    await this.post(`/api/runner/runs/${encodeURIComponent(runId)}/events`, { events });
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
