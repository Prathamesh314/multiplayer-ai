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
};

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
