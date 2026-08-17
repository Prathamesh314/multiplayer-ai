/**
 * The terminal routes execute arbitrary shell commands on the machine serving
 * this app. That is remote code execution by design, so access is gated twice:
 *
 *  1. Enabled only in development, unless MULTIPLAYER_AI_TERMINAL=1 opts in.
 *  2. The request must have arrived over a loopback Host.
 *
 * MULTIPLAYER_AI_TERMINAL=0 turns it off everywhere, including development.
 */

export type TerminalAccess = { allowed: true } | { allowed: false; reason: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0000:0000:0000:0000:0000:0000:0000:0001"]);

export function terminalAccess(request: Request): TerminalAccess {
  const flag = process.env.MULTIPLAYER_AI_TERMINAL?.toLowerCase();

  if (flag === "0" || flag === "off" || flag === "false") {
    return { allowed: false, reason: "The terminal is disabled by MULTIPLAYER_AI_TERMINAL." };
  }

  const optedIn = flag === "1" || flag === "on" || flag === "true";
  if (process.env.NODE_ENV === "production" && !optedIn) {
    return {
      allowed: false,
      reason:
        "The terminal is disabled in production builds. Set MULTIPLAYER_AI_TERMINAL=1 to enable it — only do that on a machine you control.",
    };
  }

  const host = request.headers.get("host") ?? "";
  // Strip the port; IPv6 hosts keep their brackets.
  const hostname = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];

  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
    return {
      allowed: false,
      reason: `The terminal only accepts loopback requests, and this one arrived for “${hostname || "unknown host"}”.`,
    };
  }

  return { allowed: true };
}
