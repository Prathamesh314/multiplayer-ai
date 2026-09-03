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
export type AgentId = "claude" | "gemini" | "codex";

/** A selectable value (model or reasoning effort). Empty id → the CLI default. */
export type AgentChoice = { id: string; label: string };

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
export type RunOptions = { model?: string; effort?: string };

export type AgentSpec = {
  id: AgentId;
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
     * acceptEdits, not bypassPermissions: stdin is closed, so an agent that
     * stops to ask permission just stalls and reports nothing. This lets it
     * edit files in the working copy while still refusing the riskier tools —
     * and everything it writes is committed, so any edit is reversible.
     */
    promptArgs: (prompt, opts) => [
      ...(opts?.model ? ["--model", opts.model] : []),
      "--permission-mode",
      "acceptEdits",
      "-p",
      prompt,
    ],
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
    models: [
      { id: "", label: "Auto" },
      { id: "gemini-2.5-pro", label: "2.5 Pro" },
      { id: "gemini-2.5-flash", label: "2.5 Flash" },
    ],
    efforts: [],
    install: {
      command: "npm install -g @google/gemini-cli",
      docs: "https://github.com/google-gemini/gemini-cli",
    },
    blurb: "Large-context agent for reading and changing a codebase.",
  },
];

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
};
