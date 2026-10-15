/*
 * Runner configuration: where the paired identity lives on this machine.
 *
 * One JSON file — server URL, device token, display name, private data dir
 * and the visible worktrees directory. The token is the only secret; the file is
 * chmod 600 for the same reason an ssh key is.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Paths moved with the Multicode AI rename. A runner that was already paired
 * keeps using the directory it created: re-pairing and re-cloning every
 * worktree is not an acceptable cost for a name change. New installs get the
 * current name. `multiplayer-ai` is the pre-rename product name, not a typo.
 */
function renamedPath(current: string, legacy: string): string {
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

export type RunnerConfig = {
  server: string;
  token: string;
  name: string;
  dataDir: string;
  /** Visible repository/room worktrees, separate from private runner state. */
  workspacesDir?: string;
  /**
   * An optional personal cap on turns running at once. Unset means no cap:
   * every task its user starts runs, as in a desktop orchestrator.
   */
  maxParallel?: number;
  /** Ignored files copied from a room's worktree into each new parallel-chat worktree. */
  copyIgnoredFiles?: string[];
};

/**
 * Flag, then environment, then config file: the first positive whole number
 * wins. Nothing set (or nothing valid) means no cap.
 */
export function resolveMaxParallel(...values: unknown[]): number {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isInteger(number) && number >= 1) return number;
  }
  return Infinity;
}

/** Exact relative paths only, such as ".env.local" or "apps/web/.env"; anything else is dropped. */
export function resolveCopyIgnoredFiles(value: unknown): string[] {
  const list = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  return [...new Set(list.filter((item): item is string => typeof item === "string").map(item => item.trim())
    .filter(item => /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(item) && !item.split("/").some(part => part === "." || part === "..")))];
}

export function configPath(): string {
  if (process.env.RUNNER_CONFIG) return process.env.RUNNER_CONFIG;
  const config = join(homedir(), ".config");
  return renamedPath(join(config, "multicode-ai", "runner.json"), join(config, "multiplayer-ai", "runner.json"));
}

export function defaultDataDir(): string {
  return join(homedir(), ".multiplayer-ai-runner");
}

export function defaultWorkspacesDir(): string {
  return renamedPath(join(homedir(), "multicode-ai", "workspaces"), join(homedir(), "multiplayer-ai", "workspaces"));
}

export function resolveWorkspacesDir(value?: string | null): string {
  const path = value?.trim();
  if (!path) return defaultWorkspacesDir();
  if (path === "~") return homedir();
  return resolve(path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path);
}

export function loadConfig(): RunnerConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<RunnerConfig>;
    if (!parsed.server || !parsed.token) return null;
    return {
      server: parsed.server,
      token: parsed.token,
      name: parsed.name ?? "runner",
      dataDir: parsed.dataDir ?? defaultDataDir(),
      workspacesDir: resolveWorkspacesDir(parsed.workspacesDir),
      maxParallel: parsed.maxParallel,
      copyIgnoredFiles: parsed.copyIgnoredFiles,
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: RunnerConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
