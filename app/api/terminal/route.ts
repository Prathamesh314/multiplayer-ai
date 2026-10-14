import { withApiLimit } from "../../lib/http/api-limit";
import { terminalUser } from "../../lib/terminal/guard";
import { NO_SHELL_REASON, resolveShell } from "../../lib/terminal/shell";
import type { TerminalStatus } from "../../lib/terminal/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether an interactive terminal may run here. The live shell itself is served
 * by the pty route; this only reports enablement (and the shell/cwd to show)
 * without disclosing anything about the host when access is denied — including
 * to a signed-out caller, since cwd and shell describe the server.
 *
 * The shell comes from the same resolver the PTY spawns, so "enabled" means a
 * shell was actually found. Reporting one path while spawning another is what
 * made a shell-less host look available and then fail silently.
 */
async function handleGET(request: Request) {
  const caller = await terminalUser(request);
  if ("reason" in caller) {
    return json({ enabled: false, reason: caller.reason, cwd: "", shell: "", platform: "" });
  }

  const shell = resolveShell();
  if (!shell) return json({ enabled: false, reason: NO_SHELL_REASON, cwd: "", shell: "", platform: "" });

  return json({ enabled: true, cwd: process.cwd(), shell: shell.file, platform: process.platform });
}

const json = (status: TerminalStatus) => Response.json(status, { headers: { "cache-control": "no-store" } });

export const GET = withApiLimit("/api/terminal", handleGET);
