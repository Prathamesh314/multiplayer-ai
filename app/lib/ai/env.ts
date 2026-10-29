/**
 * The environment a locally-spawned agent CLI gets.
 *
 * Process markers left by whatever launched this server are stripped: a server started
 * from a shell inside Claude Code inherits CLAUDECODE=1, and the agent then
 * refuses to start because it believes it is being nested. It is not — this is
 * a separate process spawned by a server — so the stale marker is dropped
 * rather than the check bypassed.
 *
 * Configuration such as CLAUDE_CODE_GIT_BASH_PATH is not a process marker.
 * Removing it breaks Windows installations with a custom Git Bash location.
 * Credentials are deliberately left alone: the agent authenticates the same way
 * it does when the operator runs it by hand. This app never injects, reads, or
 * strips the token — the CLI owns it.
 *
 * Gemini CLI (0.6x and later) refuses to run headless in a folder nobody has
 * trusted interactively, and the runner always runs it in the task's own
 * worktree, a folder it created for that repository. Trust is granted for this
 * one process through GEMINI_CLI_TRUST_WORKSPACE, which older versions ignore;
 * the `--skip-trust` flag would make them fail on an unknown option. Like
 * Claude Code in print mode, it then reads the repository's own settings.
 */
export function agentEnv(agentId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].includes(key.toUpperCase())) delete env[key];
  }
  if (agentId === "ollama" || agentId === "codex-ollama") env.OLLAMA_HOST = "http://127.0.0.1:11434";
  if (agentId === "codex-ollama" || agentId === "codex-lmstudio") delete env.CODEX_OSS_BASE_URL;
  if (agentId === "gemini") env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  return env;
}
