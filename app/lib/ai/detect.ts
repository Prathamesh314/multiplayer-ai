import { execFile } from "node:child_process";
import { AGENTS, type AgentSpec, type AgentStatus } from "./catalog";

/**
 * Detection is "does the tool answer --version", not "is there a file on PATH".
 *
 * A binary that exists but is broken — a half-finished install, a dangling
 * symlink from an uninstalled node version — should read as missing, because
 * offering Connect for it would fail later and more confusingly.
 */
const PROBE_TIMEOUT_MS = 4_000;

/** Spawning three processes per poll would be wasteful; installs are rare. */
const CACHE_MS = 30_000;

let cache: { at: number; statuses: AgentStatus[] } | null = null;

function probe(agent: AgentSpec): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      agent.bin,
      agent.versionArgs,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const line = stdout.split("\n").find((text) => text.trim().length > 0);
        resolve(line?.trim().slice(0, 80) ?? "installed");
      },
    );
  });
}

export async function detectAgents(force = false): Promise<AgentStatus[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.statuses;

  const statuses = await Promise.all(
    AGENTS.map(async (agent) => {
      const version = await probe(agent);
      return {
        id: agent.id,
        name: agent.name,
        vendor: agent.vendor,
        blurb: agent.blurb,
        installed: version !== null,
        version,
        install: agent.install,
      } satisfies AgentStatus;
    }),
  );

  cache = { at: Date.now(), statuses };
  return statuses;
}

/** Called after an install so the panel does not wait out the cache. */
export function invalidateAgentCache(): void {
  cache = null;
}
