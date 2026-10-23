import { commandLine } from "../ai/command";

/** Runner caches and linked-worktree indexes can exceed Windows' 260-character limit. */
export function gitCommand(args: string[]): [string, string[]] {
  return commandLine("git", [
    ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
    ...args,
  ]);
}
