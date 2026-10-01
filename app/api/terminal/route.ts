import { withApiLimit } from "../../lib/http/api-limit";
import { terminalAccess } from "../../lib/terminal/guard";
import type { TerminalStatus } from "../../lib/terminal/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether an interactive terminal may run here. The live shell itself is served
 * by the pty route; this only reports enablement (and the shell/cwd to show)
 * without disclosing anything about the host when access is denied.
 */
async function handleGET(request: Request) {
  const access = terminalAccess(request);

  const status: TerminalStatus = access.allowed
    ? {
        enabled: true,
        cwd: process.cwd(),
        shell: shellPath(),
        platform: process.platform,
      }
    : { enabled: false, reason: access.reason, cwd: "", shell: "", platform: "" };

  return Response.json(status, { headers: { "cache-control": "no-store" } });
}

function shellPath(): string {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  return process.env.SHELL ?? "/bin/sh";
}

export const GET = withApiLimit("/api/terminal", handleGET);
