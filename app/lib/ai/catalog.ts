import { createOpenCodeStreamParser } from "./opencode-stream";
import { createClaudeStreamParser, type StreamParser } from "./stream";

/**
 * The coding agents this app knows how to talk to.
 *
 * All of them are command-line tools that run on the machine serving this app,
 * so connecting one is the same class of thing as opening the terminal — see
 * `app/lib/terminal/guard.ts`, whose rules the run endpoint reuses.
 *
 * Each is driven in its one-shot, non-interactive mode. Their interactive TUIs
 * need a pty, which is a much larger piece of work than this.
 */
export type AgentId = "claude" | "gemini" | "codex" | "ollama" | "opencode" | "codex-ollama" | "codex-lmstudio";

/** A selectable value (model or reasoning effort). Empty id → the CLI default. */
export type AgentChoice = { id: string; label: string; efforts?: AgentChoice[] };

export type ModelInventory = {
  choices: AgentChoice[];
  source: string;
  checkedAt: number;
  refreshedAt: number | null;
  stale: boolean;
  error?: string;
};

/**
 * An agent's account-login state, as reported by its own CLI.
 *
 * This is a *read* of a credential the CLI owns and stores itself (its keychain
 * entry or config) — this app never sees, holds, or transmits the token. It is
 * how the panel can say "signed in as you, on Max" versus "sign in first",
 * exactly the way Conductor reuses the machine's existing Claude Code login.
 */
export type AgentAuth = {
  loggedIn: boolean;
  /** e.g. "claude.ai" (subscription) or "console" (API billing); null if unknown. */
  method: string | null;
  email: string | null;
  /** Subscription tier when signed in with a subscription, e.g. "max"; else null. */
  plan: string | null;
};

/** What the composer's Model / Capacity selectors send back with a prompt. */
export type RunOptions = {
  model?: string;
  effort?: string;
  /** Tool rules the chat always allows (lib/ai/permissions.ts). */
  allowedTools?: string[];
};

export type AgentSpec = {
  id: AgentId;
  requiresModel?: boolean;
  name: string;
  vendor: string;
  /** Executable looked up on PATH. */
  bin: string;
  versionArgs: string[];
  /**
   * argv for a single prompt. Never a shell string — the prompt is a value.
   * `opts` carries an optional model / reasoning-effort chosen in the composer;
   * an empty or absent value means "let the CLI use its own default".
   */
  promptArgs: (prompt: string, opts?: RunOptions) => string[];
  /**
   * Set for an agent that takes its prompt on stdin as a JSON line and asks
   * before using a tool by writing a control request on stdout (Claude Code's
   * stdio permission protocol). The runner relays each request to the chat and
   * answers on stdin (runner/claude-control.ts). `promptArgs` then omits the prompt.
   */
  stdinPrompt?: (prompt: string) => unknown;
  /**
   * When set, this agent's stdout is newline-delimited JSON rather than plain
   * text. A fresh parser is created per run and fed each line; it yields the
   * reply (token by token), the thinking trace, and tool activity. This is what
   * makes a run visibly working instead of the answer landing whole at the end.
   * Absent → stdout is the reply verbatim.
   */
  createStreamParser?: () => StreamParser;
  /** Models offered in the composer. First entry is the default ("Auto"). */
  models: AgentChoice[];
  /** Reasoning-effort levels offered, where the CLI supports them. May be empty. */
  efforts: AgentChoice[];
  /**
   * How to read and drive this agent's own account login, for the CLIs that
   * expose it. Absent → the app can only tell whether the tool is installed,
   * not whether it is signed in. Every arg list is passed as argv (never a
   * shell string), and the app only ever *invokes* these — the CLI keeps the
   * credential to itself.
   */
  auth?: {
    /** Prints the current login state; parsed by `parseStatus`. */
    statusArgs: string[];
    /** Starts an interactive sign-in (opens the vendor's browser OAuth flow). */
    loginArgs: string[];
    /** Clears the stored login. */
    logoutArgs: string[];
    /** Normalizes the status command's stdout. Throws on unparseable output. */
    parseStatus: (stdout: string) => AgentAuth;
  };
  install: {
    /** Shown first: works the same on every platform. */
    command: string;
    /** Offered when the vendor has a first-party installer worth preferring. */
    alternative?: string;
    docs: string;
  };
  blurb: string;
};

export const AGENTS: AgentSpec[] = [
  {
    id: "claude",
    name: "Claude Code",
    vendor: "Anthropic",
    bin: "claude",
    versionArgs: ["--version"],
    /*
     * -p is print mode: run the prompt, write the answer, exit.
     *
     * acceptEdits, not bypassPermissions: edits in the working copy go ahead
     * (everything is committed, so any edit is reversible), and anything else
     * that needs permission, such as a web fetch, an MCP connector or a shell
     * command, is asked. --permission-prompt-tool=stdio sends each such request
     * to the runner as a control request; the runner asks the chat and answers
     * (runner/claude-control.ts). Rules the chat always allows are passed as
     * settings, which take any characters safely.
     *
     * The prompt goes on stdin as a stream-json user message, so its length is
     * not bounded by the command line.
     *
     * stream-json + partial messages make the reply stream token by token;
     * without them, print mode buffers the whole answer to the end and the run
     * looks frozen the entire time. --verbose is required to stream under -p.
     * `parseStreamLine` below turns those JSON events back into plain text.
     */
    promptArgs: (_prompt, opts) => [
      ...(opts?.model ? ["--model", opts.model] : []),
      "--permission-mode",
      "acceptEdits",
      ...(opts?.allowedTools?.length ? ["--settings", JSON.stringify({ permissions: { allow: opts.allowedTools } })] : []),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--input-format",
      "stream-json",
      "--permission-prompt-tool=stdio",
      "-p",
    ],
    stdinPrompt: (prompt) => ({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } }),
    createStreamParser: createClaudeStreamParser,
    models: [
      { id: "", label: "Auto" },
      { id: "opus", label: "Opus" },
      { id: "sonnet", label: "Sonnet" },
      { id: "haiku", label: "Haiku" },
    ],
    // Claude Code has no reasoning-effort flag in print mode; capability follows
    // the model tier instead.
    efforts: [],
    /*
     * Claude Code owns its own login. `auth status --json` reports it without
     * spending a token; `auth login --claudeai` runs the subscription OAuth
     * flow (a Max/Pro plan, not per-token API billing — the whole point of
     * reusing it); `auth logout` clears it. The app never touches the token.
     */
    auth: {
      statusArgs: ["auth", "status", "--json"],
      loginArgs: ["auth", "login", "--claudeai"],
      logoutArgs: ["auth", "logout"],
      parseStatus: (stdout) => {
        const data = JSON.parse(stdout) as {
          loggedIn?: boolean;
          authMethod?: string;
          email?: string;
          subscriptionType?: string;
        };
        return {
          loggedIn: data.loggedIn === true,
          method: data.authMethod ?? null,
          email: data.email ?? null,
          plan: data.subscriptionType ?? null,
        };
      },
    },
    install: {
      command: "npm install -g @anthropic-ai/claude-code",
      alternative: "curl -fsSL https://claude.ai/install.sh | bash",
      docs: "https://docs.claude.com/en/docs/claude-code",
    },
    blurb: "Reads and edits files, runs commands, works across the whole repo.",
  },
  {
    id: "codex",
    name: "Codex CLI",
    vendor: "OpenAI",
    bin: "codex",
    versionArgs: ["--version"],
    // workspace-write is the equivalent bound: it may change this repo and
    // nothing outside it.
    promptArgs: (prompt, opts) => [
      "exec",
      "--sandbox",
      "workspace-write",
      ...(opts?.model ? ["-m", opts.model] : []),
      ...(opts?.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : []),
      prompt,
    ],
    models: [{ id: "", label: "Auto" }],
    efforts: [
      { id: "", label: "Auto" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    install: {
      command: "npm install -g @openai/codex",
      alternative: "brew install codex",
      docs: "https://developers.openai.com/codex/cli",
    },
    blurb: "Runs a task to completion in the working copy and reports back.",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    vendor: "Google",
    bin: "gemini",
    versionArgs: ["--version"],
    promptArgs: (prompt, opts) => [
      ...(opts?.model ? ["-m", opts.model] : []),
      "-p",
      prompt,
    ],
    models: [{ id: "", label: "Auto · CLI default" }],
    efforts: [],
    install: {
      command: "npm install -g @google/gemini-cli",
      docs: "https://github.com/google-gemini/gemini-cli",
    },
    blurb: "Large-context agent for reading and changing a codebase.",
  },
  {
    id: "ollama",
    name: "Ollama",
    vendor: "Local",
    bin: "ollama",
    versionArgs: ["--version"],
    requiresModel: true,
    promptArgs: (prompt, opts) => ["run", requiredModel(opts), "--", prompt],
    models: [],
    efforts: [],
    install: {
      command: "brew install ollama",
      alternative: "Download the installer from ollama.com",
      docs: "https://ollama.com",
    },
    blurb:
      "Models installed in Ollama. Chat only; use Codex + Ollama for file editing. Endpoint configuration determines where inference runs.",
  },
  {
    id: "opencode", name: "OpenCode · multi-provider", vendor: "Multi-provider",
    bin: "opencode", versionArgs: ["--version"], requiresModel: true,
    promptArgs: (prompt, opts) => ["run", "--format", "json", "--model", requiredModel(opts), ...(opts?.effort ? ["--variant", opts.effort] : []), "--", prompt],
    createStreamParser: createOpenCodeStreamParser,
    models: [], efforts: [],
    install: { command: "npm install -g opencode-ai", docs: "https://opencode.ai/docs/providers/" },
    blurb: "Coding agents through configured providers: OpenRouter, Anthropic, Google, OpenAI, DeepSeek, Groq, and more. Connect accounts once with opencode auth login on your runner.",
  },
  ...(["ollama", "lmstudio"] as const).map(provider => ({
    id: `codex-${provider}` as AgentId,
    name: provider === "ollama" ? "Codex + Ollama" : "Codex + LM Studio",
    vendor: "Local", bin: "codex", versionArgs: ["--version"], requiresModel: true,
    promptArgs: (prompt: string, opts?: RunOptions) => ["exec", "--sandbox", "workspace-write", "--oss", "--local-provider", provider, "-m", requiredModel(opts), "--", prompt],
    models: [], efforts: [],
    install: { command: "npm install -g @openai/codex", docs: provider === "ollama" ? "https://docs.ollama.com/" : "https://lmstudio.ai/docs/developer" },
    blurb: "Local coding through Codex's workspace-write sandbox. Start the local model server and install a tool-capable model first.",
  })),
];

function requiredModel(opts?: RunOptions): string {
  if (!opts?.model) throw new Error("Choose an available model before running this provider.");
  return opts.model;
}

/** Validates a choice id against a spec's allow-list; empty/unknown → undefined. */
export function resolveChoice(choices: AgentChoice[], id: unknown): string | undefined {
  if (typeof id !== "string" || id === "") return undefined;
  return choices.some((choice) => choice.id === id) ? id : undefined;
}

export const agentById = (id: string): AgentSpec | undefined =>
  AGENTS.find((agent) => agent.id === id);

/** What the browser is told about one agent. */
export type AgentStatus = {
  id: AgentId;
  name: string;
  vendor: string;
  blurb: string;
  installed: boolean;
  execution?: "runner";
  models?: ModelInventory;
  /** Reported by the tool itself, when it is there. */
  version: string | null;
  /**
   * Login state, for agents whose CLI exposes it and that are installed.
   * `null` means "not knowable here" (no auth mechanism, or not installed) —
   * distinct from `{ loggedIn: false }`, which means "installed but signed out".
   */
  auth: AgentAuth | null;
  install: AgentSpec["install"];
};

export type AgentsResponse = {
  agents: AgentStatus[];
  /**
   * Whether this server will actually run an agent. Detection is harmless and
   * always answered; running is gated exactly like the terminal.
   */
  canRun: boolean;
  reason: string | null;
  /** Whether new chats may run in parallel on their own branches (PARALLEL_CHATS). */
  parallelChats: boolean;
};
