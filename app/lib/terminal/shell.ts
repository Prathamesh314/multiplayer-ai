/**
 * Which shell a hosted terminal actually spawns.
 *
 * This exists because the old code hard-coded `/bin/zsh` as the POSIX fallback
 * while the status route reported `/bin/sh`. On a developer's Mac zsh is there
 * and both were "right enough"; in the production image (node:24-slim) there
 * is no zsh at all, `SHELL` is unset, and node-pty does not throw for a missing
 * binary — it spawns, the process dies immediately, and the browser shows a
 * black pane that says the process exited. That is the whole bug: the terminal
 * was enabled, authorised, routed, and then asked to run a shell that did not
 * exist.
 *
 * So: resolve once, from candidates that are checked against the filesystem,
 * and have both the PTY and the status endpoint use this. They can no longer
 * disagree about what will be run, or claim a terminal is available on a host
 * with no shell to give it.
 */

import { accessSync, constants } from "node:fs";

/** Preference order. zsh and bash first; dash is a usable last resort. */
const POSIX_CANDIDATES = ["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "/bin/sh"];

export type ResolvedShell = { file: string; args: string[] };

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Interactive login flags. Bourne-family shells take `-il`; cmd.exe and
 * PowerShell do not, and passing it to them produced an unusable terminal on
 * Windows even when a shell was found.
 */
function loginArgs(file: string): string[] {
  const name = file.toLowerCase();
  if (name.endsWith("cmd.exe")) return [];
  if (name.includes("powershell") || name.endsWith("pwsh.exe")) return ["-NoLogo"];
  return ["-il"];
}

/**
 * The shell to run, or null when the host has none. `MULTIPLAYER_AI_SHELL`
 * overrides the search — an operator running a slim image can point at
 * whatever they installed without rebuilding the application.
 */
export function resolveShell(): ResolvedShell | null {
  const configured = process.env.MULTIPLAYER_AI_SHELL?.trim();
  if (configured) return executable(configured) ? { file: configured, args: loginArgs(configured) } : null;

  if (process.platform === "win32") {
    const file = process.env.ComSpec?.trim() || "cmd.exe";
    return { file, args: loginArgs(file) };
  }

  // $SHELL is the user's preference, but it describes the *login* account and
  // can name a shell this container does not have; it only wins if it exists.
  const preferred = process.env.SHELL?.trim();
  const candidates = preferred ? [preferred, ...POSIX_CANDIDATES] : POSIX_CANDIDATES;
  const file = candidates.find(executable);
  return file ? { file, args: loginArgs(file) } : null;
}

export const NO_SHELL_REASON =
  "No usable shell was found on the server. Install bash (or set MULTIPLAYER_AI_SHELL to a shell that exists on this host) and restart.";
