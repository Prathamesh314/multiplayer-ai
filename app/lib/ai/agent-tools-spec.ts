/*
 * MCP servers and plugins configured in the app (lib/ai/agent-tools.ts) and
 * applied by members' computers to each agent run (runner/agent-tools.ts).
 * Pure and shared by the server, the browser and the runner.
 *
 * Secrets never appear in a definition: a value refers to them as ${NAME},
 * and each computer fills that in from its own store at run time.
 */

export type ToolVar = { name: string; value: string };
export type McpSpec =
  | { transport: "stdio"; command: string; args: string[]; env: ToolVar[] }
  | { transport: "http"; url: string; headers: ToolVar[] };
export type PluginSpec =
  | { source: "git"; url: string; ref?: string; path?: string }
  | { source: "zip"; url: string };
export type ToolKind = "mcp" | "plugin";
export type ToolSpec = McpSpec | PluginSpec;

/** One tool as a run receives it. */
export type RunTool = { id: string; kind: ToolKind; name: string; spec: ToolSpec; hash: string };

export class ToolSpecError extends Error {}

const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SECRET = /\$\{([A-Z][A-Z0-9_]{0,63})\}/g;
const text = (value: unknown, max: number, label: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new ToolSpecError(`${label} is missing or too long.`);
  return value.trim();
};
const optional = (value: unknown, max: number, label: string) => (value == null || value === "" ? undefined : text(value, max, label));
function httpsUrl(value: unknown, label: string) {
  const url = text(value, 2000, label);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ToolSpecError(`${label} is not a valid URL.`); }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(parsed.hostname))) {
    throw new ToolSpecError(`${label} must use https (or http on localhost).`);
  }
  if (parsed.username || parsed.password) throw new ToolSpecError(`Put credentials in a \${NAME} secret, not in the ${label.toLowerCase()}.`);
  return url;
}
function vars(value: unknown, label: string): ToolVar[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) throw new ToolSpecError(`Too many ${label.toLowerCase()}.`);
  const seen = new Set<string>();
  return value.map((item) => {
    const name = text((item as ToolVar)?.name, 64, `${label} name`);
    if (!VAR_NAME.test(name) && label !== "Headers") throw new ToolSpecError(`${name} is not a valid ${label.toLowerCase().replace(/s$/, "")} name.`);
    if (label === "Headers" && !/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new ToolSpecError(`${name} is not a valid header name.`);
    if (seen.has(name.toLowerCase())) throw new ToolSpecError(`${name} is listed twice.`);
    seen.add(name.toLowerCase());
    return { name, value: text((item as ToolVar)?.value, 2000, `${name}'s value`) };
  });
}

/** A tool's name: lowercase letters, numbers, - and _ (it becomes the MCP server name). */
export function toolName(value: unknown) {
  const name = text(value, 48, "Name").toLowerCase();
  if (!NAME.test(name)) throw new ToolSpecError("Use lowercase letters, numbers, - and _ for the name.");
  return name;
}

/** A definition, validated and normalised; throws ToolSpecError with a person-readable reason. */
export function normaliseSpec(kind: unknown, spec: unknown): { kind: ToolKind; spec: ToolSpec } {
  const input = (spec ?? {}) as Record<string, unknown>;
  if (kind === "mcp") {
    if (input.transport === "stdio") {
      const args = input.args == null ? [] : input.args;
      if (!Array.isArray(args) || args.length > 40) throw new ToolSpecError("Too many arguments.");
      return { kind, spec: { transport: "stdio", command: text(input.command, 300, "Command"), args: args.map((arg, index) => {
        if (typeof arg !== "string" || arg.length > 1000 || /[\0\r\n]/.test(arg)) throw new ToolSpecError(`Argument ${index + 1} is invalid.`);
        return arg;
      }), env: vars(input.env, "Environment variables") } };
    }
    if (input.transport === "http") return { kind, spec: { transport: "http", url: httpsUrl(input.url, "URL"), headers: vars(input.headers, "Headers") } };
    throw new ToolSpecError("Choose how the MCP server runs: a command on the computer, or an HTTP URL.");
  }
  if (kind === "plugin") {
    if (input.source === "git") {
      const ref = optional(input.ref, 200, "Branch or tag"), path = optional(input.path, 300, "Folder");
      if (ref && !/^[A-Za-z0-9._/-]+$/.test(ref)) throw new ToolSpecError("The branch or tag has unusual characters.");
      if (path && (path.split("/").some((part) => part === ".." || part === ".") || path.startsWith("/"))) throw new ToolSpecError("The folder must be a path inside the repository.");
      return { kind, spec: { source: "git", url: httpsUrl(input.url, "Repository URL"), ...(ref ? { ref } : {}), ...(path ? { path: path.replace(/\/+$/, "") } : {}) } };
    }
    if (input.source === "zip") return { kind, spec: { source: "zip", url: httpsUrl(input.url, "Plugin URL") } };
    throw new ToolSpecError("Choose where the plugin comes from: a Git repository or a .zip URL.");
  }
  throw new ToolSpecError("Choose an MCP server or a plugin.");
}

/** The ${NAME} secrets a definition needs from each computer. */
export function secretNames(spec: ToolSpec): string[] {
  const strings = "transport" in spec
    ? spec.transport === "stdio" ? [spec.command, ...spec.args, ...spec.env.map((item) => item.value)] : [spec.url, ...spec.headers.map((item) => item.value)]
    : [spec.url];
  const names = new Set<string>();
  for (const value of strings) for (const match of value.matchAll(SECRET)) names.add(match[1]);
  return [...names].sort();
}

/** Fill ${NAME} from a computer's secrets; missing names are reported, not guessed. */
export function fillSecrets(value: string, lookup: (name: string) => string | undefined, missing: Set<string>) {
  return value.replace(SECRET, (whole, name: string) => {
    const found = lookup(name);
    if (found == null) { missing.add(name); return whole; }
    return found;
  });
}

/** One line for the UI: what runs, or where it comes from. */
export function describeSpec(spec: ToolSpec): string {
  if ("transport" in spec) return spec.transport === "stdio" ? [spec.command, ...spec.args].join(" ") : spec.url;
  return spec.source === "git" ? `${spec.url}${spec.ref ? ` @ ${spec.ref}` : ""}${spec.path ? ` · ${spec.path}` : ""}` : spec.url;
}

/** Which agents can use a tool: plugins are a Claude Code feature. */
export const toolAgents = (kind: ToolKind) => (kind === "plugin" ? ["claude"] : ["claude", "codex"]);

/** Starting points in the "Add" form; each is an ordinary, editable definition. */
export const TOOL_PRESETS: { id: string; label: string; description: string; name: string; kind: ToolKind; spec: ToolSpec }[] = [
  { id: "playwright", label: "Playwright", description: "Drive a real browser to test and inspect pages.", name: "playwright", kind: "mcp",
    spec: { transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], env: [] } },
  { id: "context7", label: "Context7", description: "Up-to-date library documentation for the agent.", name: "context7", kind: "mcp",
    spec: { transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], env: [] } },
  { id: "github", label: "GitHub", description: "Issues, pull requests and code through GitHub's MCP server.", name: "github", kind: "mcp",
    spec: { transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: [{ name: "Authorization", value: "Bearer ${GITHUB_TOKEN}" }] } },
  { id: "postgres", label: "PostgreSQL", description: "Read-only queries against a database.", name: "postgres", kind: "mcp",
    spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "${DATABASE_URL}"], env: [] } },
];

/** "npx -y pkg --flag 'two words'" → ["npx", "-y", "pkg", "--flag", "two words"]. Quotes group; no shell runs it. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let current = "", quote: string | null = null, started = false;
  for (const char of line.trim()) {
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { words.push(current); current = ""; started = false; } continue; }
    current += char; started = true;
  }
  if (quote) throw new ToolSpecError("A quote in the command is not closed.");
  if (started) words.push(current);
  return words;
}

/** The inverse of splitCommand, for editing. */
export const joinCommand = (words: string[]) => words.map((word) => (!word || /[\s"']/.test(word) ? `"${word.replace(/"/g, "'")}"` : word)).join(" ");

/** One `NAME=value` (or `Name: value` for headers) per line. */
export function parseVars(text: string, separator: "=" | ":"): ToolVar[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf(separator);
    if (at <= 0) throw new ToolSpecError(`Write each line as NAME${separator === "=" ? "=" : ": "}value.`);
    return { name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() };
  });
}
export const formatVars = (items: ToolVar[], separator: "=" | ":") => items.map((item) => `${item.name}${separator === "=" ? "=" : ": "}${item.value}`).join("\n");
