/**
 * The environment a locally-spawned agent CLI gets.
 *
 * Markers left by whatever launched this server are stripped: a server started
 * from a shell inside Claude Code inherits CLAUDECODE=1, and the agent then
 * refuses to start because it believes it is being nested. It is not — this is
 * a separate process spawned by a server — so the stale marker is dropped
 * rather than the check bypassed.
 *
 * Credentials are deliberately left alone: the agent authenticates the same way
 * it does when the operator runs it by hand. This app never injects, reads, or
 * strips the token — the CLI owns it.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  return env;
}
