import { withApiLimit } from "../../lib/http/api-limit";
import { currentUser } from "../../lib/auth/tokens";
import { terminalUser } from "../../lib/terminal/guard";
import { NO_SHELL_REASON, resolveShell } from "../../lib/terminal/shell";
import { computerTerminals, pickTerminalDevice } from "../../lib/terminal/remote";
import type { TerminalStatus } from "../../lib/terminal/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether an interactive terminal is available, and where it runs.
 *
 * Where runners can connect, terminals open on the member's own computer (in
 * the chat's worktree, through their runner), like their AI agents; this
 * reports which computer, or asks them to connect one. Elsewhere (a
 * development server without Redis) the shell is on the machine serving the
 * app, behind the terminal gate, and nothing about the host is disclosed
 * when access is denied.
 */
async function handleGET(request: Request) {
  if (computerTerminals()) {
    const user = await currentUser();
    if (!user) return json({ enabled: false, reason: "Sign in to use the terminal.", location: "computer", cwd: "", shell: "", platform: "" });
    const device = await pickTerminalDevice(user.id, new URL(request.url).searchParams.get("runId"));
    return json(device
      ? { enabled: true, location: "computer", device: device.name, cwd: "", shell: "", platform: "" }
      : { enabled: false, location: "computer", cwd: "", shell: "", platform: "",
          reason: "Terminals open on your computer, in your chat's worktree. Open the desktop app or start the runner on your computer, then try again." });
  }

  const caller = await terminalUser(request);
  if ("reason" in caller) {
    return json({ enabled: false, reason: caller.reason, location: "server", cwd: "", shell: "", platform: "" });
  }
  const shell = resolveShell();
  if (!shell) return json({ enabled: false, reason: NO_SHELL_REASON, location: "server", cwd: "", shell: "", platform: "" });
  return json({ enabled: true, location: "server", cwd: process.cwd(), shell: shell.file, platform: process.platform });
}

const json = (status: TerminalStatus) => Response.json(status, { headers: { "cache-control": "no-store" } });

export const GET = withApiLimit("/api/terminal", handleGET);
