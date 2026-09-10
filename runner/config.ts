/*
 * Runner configuration: where the paired identity lives on this machine.
 *
 * One JSON file — server URL, device token, display name, and the data dir
 * that holds repo checkouts. The token is the only secret; the file is
 * chmod 600 for the same reason an ssh key is.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunnerConfig = {
  server: string;
  token: string;
  name: string;
  dataDir: string;
};

export function configPath(): string {
  return process.env.RUNNER_CONFIG || join(homedir(), ".config", "multiplayer-ai", "runner.json");
}

export function defaultDataDir(): string {
  return join(homedir(), ".multiplayer-ai-runner");
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
