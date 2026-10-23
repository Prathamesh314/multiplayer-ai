import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

/**
 * How to start an AI tool's CLI without a shell.
 *
 * On macOS and Linux the name is enough. On Windows, npm installs CLIs as
 * `.cmd` launchers (`%APPDATA%\npm\codex.cmd`), which Node cannot start
 * directly: `execFile`/`spawn` only find `.exe` files, and since Node's 2024
 * security fix they refuse `.cmd` files outright. Running them through
 * `cmd.exe` instead would let text in a prompt be read as commands. So we find
 * what the launcher runs (its JavaScript entry point, under Node) and start
 * that directly, which is exactly what the launcher itself does.
 */
export type Command = { file: string; args: string[] };

type Options = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  read?: (file: string) => string;
};

export function resolveCommand(bin: string, options: Options = {}): Command | null {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return { file: bin, args: [] };
  const env = options.env ?? process.env;
  const exists = options.exists ?? ((file: string) => existsSync(file));
  const read = options.read ?? ((file: string) => readFileSync(file, "utf8"));
  const win = path.win32;
  // Match Node's case-insensitive Windows environment lookup, including plain
  // objects passed by the desktop app where Path and PATH can coexist.
  const keys = Object.keys(env).sort();
  const value = (name: string) => env[keys.find(key => key.toLowerCase() === name.toLowerCase()) ?? name];
  const folder = (name: string, ...parts: string[]) => {
    const base = value(name);
    return base ? win.join(base, ...parts) : undefined;
  };

  const pathValue = value("PATH") ?? "";
  // A running app keeps the PATH it started with, so a CLI or Node installed
  // since then is found in its standard folder too, without a restart.
  const standard = [
    folder("APPDATA", "npm"),
    folder("USERPROFILE", ".local", "bin"),
    folder("LOCALAPPDATA", "Microsoft", "WinGet", "Links"),
    folder("ProgramFiles", "nodejs"),
    ...(/^git(?:\.exe)?$/i.test(bin) ? [
      folder("ProgramFiles", "Git", "cmd"),
      folder("ProgramFiles(x86)", "Git", "cmd"),
      folder("LOCALAPPDATA", "Programs", "Git", "cmd"),
    ] : []),
  ].filter((dir): dir is string => !!dir);
  const dirs = [...pathValue.split(";"), ...standard].map((dir) => dir.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const extensions = (value("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
  const named = /\.[a-z0-9]+$/i.test(bin) ? [bin] : extensions.map((ext) => bin + ext);

  // A selected path is already a location, not a name to append to PATH.
  const explicit = win.isAbsolute(bin) || /[\\/]/.test(bin);
  for (const dir of explicit ? [""] : dirs) {
    for (const name of named) {
      const candidate = win.join(dir, name);
      if (!exists(candidate)) continue;
      const ext = win.extname(candidate).toLowerCase();
      if (ext === ".exe" || ext === ".com") return { file: candidate, args: [] };
      if (ext === ".cmd" || ext === ".bat") {
        const target = shimTarget(candidate, read, exists, options);
        if (target) return target;
      }
    }
  }
  return null;
}

/** What an npm (cmd-shim) launcher runs: `"%dp0%\node_modules\…\cli.js" %*`. */
function shimTarget(shim: string, read: (file: string) => string, exists: (file: string) => boolean, options: Options): Command | null {
  let text: string;
  try {
    text = read(shim);
  } catch {
    return null;
  }
  const win = path.win32;
  const dir = win.dirname(shim);
  const match = /"%~?dp0%?\\([^"]+)"\s+%\*/i.exec(text);
  if (!match) return null;
  const target = win.join(dir, match[1]);
  if (!exists(target)) return null;
  if (/\.(exe|com)$/i.test(target)) return { file: target, args: [] };
  if (!/\.(c|m)?js$/i.test(target)) return null;
  // The launcher prefers a node.exe next to it, then the one on PATH.
  const local = win.join(dir, "node.exe");
  const node = exists(local) ? { file: local, args: [] } : resolveCommand("node.exe", options);
  return node ? { file: node.file, args: [target] } : null;
}

/** `bin` and its arguments, ready for spawn/execFile; the plain name when nothing better is found. */
export function commandLine(bin: string, args: string[]): [string, string[]] {
  const resolved = resolveCommand(bin);
  return resolved ? [resolved.file, [...resolved.args, ...args]] : [bin, args];
}
