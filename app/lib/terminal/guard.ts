/**
 * The terminal routes execute arbitrary shell commands on the machine serving
 * this app. That is remote code execution by design, so it is gated:
 *
 *  1. `MULTIPLAYER_AI_TERMINAL=1` is an explicit operator opt-in. It enables the
 *     terminal wherever the app runs, including a hosted production deployment
 *     reached over a real domain. Nothing else lifts the production gate.
 *  2. Without that opt-in, the terminal is development-only *and* the request
 *     must have arrived over a loopback Host — i.e. the developer's own machine.
 *  3. `MULTIPLAYER_AI_TERMINAL=0` turns it off everywhere, including development.
 *
 * The loopback rule used to apply even to the opt-in, which made the flag
 * useless on a hosted host (every request arrives for the public domain) and
 * also blocked the "run this on the app's machine" path in app/api/ai/run.
 * Lifting it moves the whole burden of authorisation onto the routes: this
 * function answers "is the feature on here", never "may this caller use it".
 * Terminal routes must additionally call `terminalUser()` — on a public host
 * the Host check is no longer standing in for authentication.
 */

import { currentUser } from "../auth/tokens";
import type { CurrentUser } from "../auth/types";

export type TerminalAccess = { allowed: true } | { allowed: false; reason: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0000:0000:0000:0000:0000:0000:0000:0001"]);

/** The request's Host without its port; IPv6 hosts keep their brackets. */
function requestHostname(request: Request): string {
  const host = request.headers.get("host") ?? "";
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
}

/** Whether the request arrived over a loopback Host, i.e. from the machine serving the app. */
export function isLoopbackRequest(request: Request): boolean {
  return LOOPBACK_HOSTS.has(requestHostname(request).toLowerCase());
}

export function terminalAccess(request: Request): TerminalAccess {
  const flag = process.env.MULTIPLAYER_AI_TERMINAL?.toLowerCase();

  if (flag === "0" || flag === "off" || flag === "false") {
    return { allowed: false, reason: "The terminal is disabled by MULTIPLAYER_AI_TERMINAL." };
  }

  // The operator has said "yes, run shells here". Host no longer matters.
  if (flag === "1" || flag === "on" || flag === "true") return { allowed: true };

  if (process.env.NODE_ENV === "production") {
    return {
      allowed: false,
      reason:
        "The terminal is disabled in production builds. Set MULTIPLAYER_AI_TERMINAL=1 to enable it — every signed-in member then gets a shell on this server.",
    };
  }

  const hostname = requestHostname(request);
  if (!isLoopbackRequest(request)) {
    return {
      allowed: false,
      reason: `Without MULTIPLAYER_AI_TERMINAL=1 the terminal only accepts loopback requests, and this one arrived for “${hostname || "unknown host"}”.`,
    };
  }

  return { allowed: true };
}

/**
 * The signed-in owner of a terminal request, or a refusal.
 *
 * Every shell is bound to the account that opened it (see pty.ts), so one
 * member can neither watch nor type into another's. This is the only identity
 * check the terminal has; it is not room-scoped, because a shell is a shell on
 * the host, not something that belongs to a room.
 */
export async function terminalUser(
  request: Request,
): Promise<{ user: CurrentUser } | { reason: string; refusal: Response }> {
  const refuse = (reason: string, status: number) => ({
    reason,
    refusal: Response.json({ error: reason }, { status, headers: { "cache-control": "no-store" } }),
  });

  const gate = terminalAccess(request);
  if (!gate.allowed) return refuse(gate.reason, 403);
  const user = await currentUser();
  if (!user) return refuse("Sign in to use the terminal.", 401);
  return { user };
}
