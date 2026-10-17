/*
 * Readable names for an agent's steps. The stream parsers record each tool
 * call as `Name target` or `Name: target` (lib/ai/stream.ts), MCP tools as
 * `mcp__<server>__<tool>`, and Codex reports raw shell commands or item types.
 * The chat shows "Google Drive · Read file content", not the raw identifier.
 */

export type Step = { label: string; detail?: string; kind: "read" | "write" | "run" | "search" | "web" | "tool" | "think" };

const KNOWN: Record<string, { label: string; kind: Step["kind"] }> = {
  Read: { label: "Read", kind: "read" },
  LS: { label: "List", kind: "read" },
  NotebookRead: { label: "Read notebook", kind: "read" },
  Write: { label: "Write", kind: "write" },
  Edit: { label: "Edit", kind: "write" },
  MultiEdit: { label: "Edit", kind: "write" },
  NotebookEdit: { label: "Edit notebook", kind: "write" },
  Bash: { label: "Run", kind: "run" },
  Grep: { label: "Search code", kind: "search" },
  Glob: { label: "Find files", kind: "search" },
  ToolSearch: { label: "Look up tools", kind: "search" },
  WebFetch: { label: "Open", kind: "web" },
  WebSearch: { label: "Search the web", kind: "web" },
  Task: { label: "Delegate", kind: "tool" },
  Agent: { label: "Delegate", kind: "tool" },
  TodoWrite: { label: "Update plan", kind: "think" },
  // Codex item types, reported when an item has no command.
  reasoning: { label: "Thinking", kind: "think" },
  fileChange: { label: "Edit files", kind: "write" },
  commandExecution: { label: "Run a command", kind: "run" },
  mcpToolCall: { label: "Use a tool", kind: "tool" },
  webSearch: { label: "Search the web", kind: "web" },
  agentMessage: { label: "Write the reply", kind: "think" },
};

const words = (value: string) => value.replace(/[_-]+/g, " ").trim();
const sentence = (value: string) => (value ? value[0].toUpperCase() + value.slice(1) : value);

/** `/bin/zsh -lc "npm test"` reads as `npm test`. */
function command(text: string) {
  const wrapped = /^\S*(?:sh|zsh|bash)\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(text.trim());
  return (wrapped ? wrapped[2] : text).trim();
}

export function describeStep(raw: string): Step {
  const step = raw.trim();
  const match = /^([A-Za-z][\w.-]*)(?::\s*|\s+|$)([\s\S]*)$/.exec(step);
  const name = match?.[1] ?? "", rest = match?.[2]?.trim() ?? "";
  if (name.startsWith("mcp__")) {
    const [server = "", tool = ""] = name.slice(5).split("__");
    const service = words(server.replace(/^claude_ai_/, ""));
    return { label: tool ? `${service} · ${sentence(words(tool))}` : service, detail: rest || undefined, kind: "tool" };
  }
  const known = KNOWN[name];
  if (known) return { label: known.label, detail: rest || undefined, kind: known.kind };
  // Anything else Codex reports is a shell command.
  if (/[\s/]/.test(step)) return { label: "Run", detail: command(step), kind: "run" };
  return { label: sentence(words(step)), kind: "tool" };
}
