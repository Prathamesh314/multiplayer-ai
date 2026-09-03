import { execFile } from "node:child_process";
import { AGENTS, type AgentAuth, type AgentSpec, type AgentStatus } from "./catalog";

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

/**
 * Reads an agent's login state via its own CLI — a fast, local, token-free
 * call. Returns null when the agent has no login mechanism. An unparseable or
 * failed status is treated as "installed but signed out" rather than unknown,
 * because that is the state that should surface a Sign in button: the CLI
 * prints its logged-out JSON on a nonzero exit too, and even a total failure
 * is best resolved by signing in.
 */
export function authStatus(agent: AgentSpec): Promise<AgentAuth | null> {
  const auth = agent.auth;
  if (!auth) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      agent.bin,
      auth.statusArgs,
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (_error, stdout) => {
        try {
          resolve(auth.parseStatus(stdout));
        } catch {
          resolve({ loggedIn: false, method: null, email: null, plan: null });
        }
      },
    );
  });
}

export async function detectAgents(force = false): Promise<AgentStatus[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.statuses;

  const statuses = await Promise.all(
    AGENTS.map(async (agent) => {
      const version = await probe(agent);
      // Only ask about login for a tool that actually answered — a missing
      // binary has no login state, and probing it would just time out.
      const auth = version !== null ? await authStatus(agent) : null;
      return {
        id: agent.id,
        name: agent.name,
        vendor: agent.vendor,
        blurb: agent.blurb,
        installed: version !== null,
        version,
        auth,
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
