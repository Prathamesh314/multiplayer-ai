import { execFile } from "node:child_process";
import { commandLine } from "../ai/command";

/** Runner caches and linked-worktree indexes can exceed Windows' 260-character limit. */
export function gitCommand(args: string[]): [string, string[]] {
  return commandLine("git", [
    ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
    ...args,
  ]);
}

let checked: { at: number; version: string | null } | null = null;

/**
 * Git's version on this computer ("2.47.1"), or null when Git cannot start.
 * AI tasks need Git, so runners report this with their AI tools. Cached like
 * tool detection: a new install is picked up within a minute.
 */
export function gitVersion(): Promise<string | null> {
  if (checked && Date.now() - checked.at < 60_000) return Promise.resolve(checked.version);
  return new Promise(resolve => {
    execFile(...gitCommand(["--version"]), { timeout: 20_000, windowsHide: true }, (error, stdout) => {
      const version = error ? null : (/git version\s+(\S+)/.exec(String(stdout))?.[1] ?? (String(stdout).trim().slice(0, 60) || null));
      checked = { at: Date.now(), version };
      resolve(version);
    });
  });
}
