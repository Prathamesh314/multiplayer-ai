/*
 * MCP servers and plugins from the app, applied to one agent run on this
 * computer (see app/lib/ai/agent-tools-spec.ts).
 *
 * Nothing here edits the member's own ~/.claude or ~/.codex settings: Claude
 * Code gets a private --mcp-config file and --plugin-dir for this run only,
 * and Codex gets the servers in its thread's config. Their own connectors
 * keep working alongside.
 *
 * Secrets live only on this computer, in <dataDir>/secrets.json (mode 600).
 * A definition names them as ${NAME}; a tool whose secrets are missing here
 * is left out of the run with a notice, never started half-configured.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, rmSync, statSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { fillSecrets, normaliseSpec, type McpSpec, type PluginSpec, type RunTool } from "../app/lib/ai/agent-tools-spec";
import { gitCommand } from "../app/lib/git/command";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SECRET_BYTES = 16 * 1024;
const PLUGIN_REFRESH_MS = 10 * 60 * 1000;

const secretsPath = (dataDir: string) => join(dataDir, "secrets.json");

/** This computer's secrets, by name. A damaged file reads as empty rather than failing every run. */
export function readSecrets(dataDir: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(secretsPath(dataDir), "utf8")) as { secrets?: Record<string, unknown> };
    const secrets: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed.secrets ?? {})) if (SECRET_NAME.test(name) && typeof value === "string") secrets[name] = value;
    return secrets;
  } catch {
    return {};
  }
}

export const secretNamesHere = (dataDir: string) => Object.keys(readSecrets(dataDir)).sort();

/** Set (or with null, remove) one secret. The file is replaced atomically and is readable by this user only. */
export function writeSecret(dataDir: string, name: string, value: string | null) {
  if (!SECRET_NAME.test(name)) throw new Error("Use capital letters, numbers and _ for the name, e.g. GITHUB_TOKEN.");
  if (value != null && (!value || Buffer.byteLength(value) > MAX_SECRET_BYTES || value.includes("\0"))) throw new Error("The value is empty or too long.");
  const secrets = readSecrets(dataDir);
  if (value == null) delete secrets[name]; else secrets[name] = value;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${secretsPath(dataDir)}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, secrets }, null, 2), { mode: 0o600, flag: "wx" });
  renameSync(temp, secretsPath(dataDir));
}

export type PreparedTools = {
  /** Extra Claude Code flags, placed before the prompt flags. */
  args: string[];
  /** Codex thread config (thread/start `config`). */
  codexConfig?: { mcp_servers: Record<string, unknown> };
  /** One line per tool that was used or left out, for the chat. */
  notices: string[];
  cleanup(): Promise<void>;
};

type Filled<T> = { spec: T; missing: string[] };
function filled<T extends McpSpec | PluginSpec>(spec: T, secrets: Record<string, string>): Filled<T> {
  const missing = new Set<string>();
  const fill = (value: string) => fillSecrets(value, (name) => secrets[name], missing);
  const vars = (items: { name: string; value: string }[]) => items.map((item) => ({ name: item.name, value: fill(item.value) }));
  let result: McpSpec | PluginSpec;
  if ("transport" in spec) {
    result = spec.transport === "stdio"
      ? { ...spec, command: fill(spec.command), args: spec.args.map(fill), env: vars(spec.env) }
      : { ...spec, url: fill(spec.url), headers: vars(spec.headers) };
  } else {
    result = { ...spec, url: fill(spec.url) };
  }
  return { spec: result as T, missing: [...missing].sort() };
}

const record = (items: { name: string; value: string }[]) => Object.fromEntries(items.map((item) => [item.name, item.value]));

function claudeServer(spec: McpSpec) {
  return spec.transport === "stdio"
    ? { type: "stdio", command: spec.command, args: spec.args, env: record(spec.env) }
    : { type: "http", url: spec.url, headers: record(spec.headers) };
}
function codexServer(spec: McpSpec) {
  return spec.transport === "stdio"
    ? { command: spec.command, args: spec.args, env: record(spec.env) }
    : { url: spec.url, http_headers: record(spec.headers) };
}

const git = (args: string[], cwd?: string) => new Promise<void>((resolve, reject) => {
  execFile(...gitCommand(args), { cwd, windowsHide: true, timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "never" } },
    (error, _stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim().split("\n").pop())) : resolve());
});

/** One clone per repository and ref, refreshed at most every few minutes and swapped in whole. */
const cloning = new Map<string, Promise<string>>();
async function pluginClone(dataDir: string, spec: Extract<PluginSpec, { source: "git" }>, onNotice: (message: string) => void): Promise<string> {
  const key = createHash("sha256").update(`${spec.url}\0${spec.ref ?? ""}`).digest("hex").slice(0, 24);
  const root = join(dataDir, "plugins"), target = join(root, key);
  const fresh = existsSync(join(target, ".git")) && Date.now() - statSync(join(target, ".git")).mtimeMs < PLUGIN_REFRESH_MS;
  if (fresh) return target;
  const pending = cloning.get(key);
  if (pending) return pending;
  const work = (async () => {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const next = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      // https only (or http to localhost, as the definition allows); no submodules, no prompts.
      await git(["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.http.allow=always",
        "clone", "--depth", "1", "--quiet", ...(spec.ref ? ["--branch", spec.ref] : []), "--", spec.url, next]);
      rmSync(target, { recursive: true, force: true });
      renameSync(next, target);
    } catch (cause) {
      rmSync(next, { recursive: true, force: true });
      if (!existsSync(join(target, ".git"))) throw cause;
      onNotice(`Using the copy downloaded earlier: ${(cause as Error).message}`);
    }
    return target;
  })().finally(() => cloning.delete(key));
  cloning.set(key, work);
  return work;
}

function insideClone(clone: string, path?: string) {
  const dir = path ? join(clone, path) : clone;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`The folder ${path ?? "/"} is not in the repository.`);
  const real = realpathSync(dir), base = realpathSync(clone);
  const inside = relative(base, real);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("The plugin folder points outside the repository.");
  return real;
}

/**
 * Turn a run's tools into what this agent understands. Tools an agent cannot
 * use are reported and left out; the run itself always goes ahead.
 */
export async function prepareTools(tools: RunTool[] | undefined, agentId: string, dataDir: string): Promise<PreparedTools> {
  const prepared: PreparedTools = { args: [], notices: [], cleanup: async () => {} };
  if (!tools?.length) return prepared;
  if (agentId !== "claude" && agentId !== "codex") {
    prepared.notices.push(`AI tools from the app work with Claude Code and Codex; this agent runs without ${tools.map((tool) => tool.name).join(", ")}.`);
    return prepared;
  }
  const secrets = readSecrets(dataDir);
  const claudeServers: Record<string, unknown> = {}, codexServers: Record<string, unknown> = {};
  const used: string[] = [];
  for (const tool of tools) {
    let normal;
    try { normal = normaliseSpec(tool.kind, tool.spec); } catch (cause) {
      prepared.notices.push(`${tool.name} left out: ${(cause as Error).message}`);
      continue;
    }
    const { spec, missing } = filled(normal.spec, secrets);
    if (missing.length) {
      prepared.notices.push(`${tool.name} left out: add ${missing.join(", ")} on this computer (AI tools → keys).`);
      continue;
    }
    if (normal.kind === "mcp") {
      if (agentId === "claude") claudeServers[tool.name] = claudeServer(spec as McpSpec);
      else codexServers[tool.name] = codexServer(spec as McpSpec);
      used.push(tool.name);
      continue;
    }
    if (agentId !== "claude") { prepared.notices.push(`${tool.name} left out: plugins work with Claude Code.`); continue; }
    const plugin = spec as PluginSpec;
    try {
      if (plugin.source === "zip") prepared.args.push("--plugin-url", plugin.url);
      else prepared.args.push("--plugin-dir", insideClone(await pluginClone(dataDir, plugin, (message) => prepared.notices.push(`${tool.name}: ${message}`)), plugin.path));
      used.push(tool.name);
    } catch (cause) {
      prepared.notices.push(`${tool.name} left out: ${(cause as Error).message}`);
    }
  }
  if (Object.keys(claudeServers).length) {
    // A file, not an argument, so filled-in secrets never show in the process list.
    const dir = await mkdtemp(join(tmpdir(), "multicode-tools-"));
    const file = join(dir, "mcp.json");
    await writeFile(file, JSON.stringify({ mcpServers: claudeServers }), { mode: 0o600 });
    prepared.args.unshift("--mcp-config", file);
    prepared.cleanup = () => rm(dir, { recursive: true, force: true });
  }
  if (Object.keys(codexServers).length) prepared.codexConfig = { mcp_servers: codexServers };
  if (used.length) prepared.notices.unshift(`AI tools for this chat: ${used.join(", ")}`);
  return prepared;
}
