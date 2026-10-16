import { localRunnersEnabled } from "../runner/jobs";
import { isLoopbackRequest } from "../terminal/guard";

/**
 * Where AI agents run.
 *
 * Agents run on each member's own computer: the desktop app or the
 * `multicode-ai-runner` claims the turn, works in a worktree there, and uses
 * that person's installed tools and AI accounts. This server only coordinates.
 *
 * This server runs an agent itself only when:
 *  - an operator opts in with `AGENT_SERVER_EXECUTION=1` (for example a
 *    single-user installation), or
 *  - it is a development server with no way to reach a runner (no Redis, or
 *    `LOCAL_RUNNERS=0`), opened from the developer's own machine.
 * `AGENT_SERVER_EXECUTION=0` forbids it everywhere.
 *
 * This is deliberately separate from the terminal (terminal/guard.ts): giving
 * members a terminal must never move their AI agents onto this server.
 */
export function serverExecutionAllowed(request: Request): boolean {
  const flag = process.env.AGENT_SERVER_EXECUTION?.toLowerCase();
  if (flag === "1" || flag === "on" || flag === "true") return true;
  if (flag === "0" || flag === "off" || flag === "false") return false;
  if (process.env.NODE_ENV === "production" || localRunnersEnabled()) return false;
  return isLoopbackRequest(request);
}
