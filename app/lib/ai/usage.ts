import { queryOne } from "../db/client";
import type { RunIsolation } from "./isolation";

/**
 * The cost governor for AI runs.
 *
 * Every run happens on a member's own computer, with that person's machine and
 * AI account, so nothing here caps how many run at once: as in a desktop
 * orchestrator, the person starting them is the limit. Period quotas apply.
 */

// Longer than MAX_RUN_MS (10 min) in the run route: a "running" row older than
// this is stale — its process is gone — and must not hold a concurrency slot.
const STALE = "15 minutes";

export type RunGate = { ok: true } | { ok: false; error: string; limit: string };

type OrgLimits = { run_monthly_quota: number | null };
type ProjectLimits = { run_hourly_limit: number | null };

async function count(sql: string, params: unknown[]): Promise<number> {
  const row = await queryOne<{ n: number }>(sql, params);
  return row?.n ?? 0;
}

/**
 * Decides whether a run may start. Period limits count accepted execution
 * turns, including continuations. This is a preflight for friendly
 * errors; reserveTurn repeats the checks atomically before admitting work.
 */
export async function checkRunAllowed(params: {
  orgId: string | null;
  projectId: string | null;
  sessionId: string;
  userId: string;
  isNewRun: boolean;
  /** A new isolated chat has a branch of its own; see isolation.ts. */
  isolation?: RunIsolation;
}): Promise<RunGate> {
  const { orgId, projectId, sessionId, userId, isNewRun } = params;

  // One live shared run per person per room: shared chats work on the same
  // branch, so a second would race the first. Parallel chats are the way to
  // run several at once. This is a correctness rule, not a capacity cap.
  if (isNewRun && params.isolation !== "isolated") {
    const mine = await count(
      `SELECT count(*)::int AS n FROM agent_runs
        WHERE session_id = $1 AND started_by = $2 AND status = 'running' AND isolation = 'shared'
          AND started_at > now() - interval '${STALE}'`,
      [sessionId, userId],
    );
    if (mine >= 1) {
      return {
        ok: false,
        limit: "room",
        error: "You already have a chat working in this room. Wait for it to finish, or start a parallel chat.",
      };
    }
  }

  // Personal rooms (no org) are governed only by the personal guards above.
  if (!orgId) return { ok: true };

  const org = await queryOne<OrgLimits>(
    `SELECT run_monthly_quota FROM orgs WHERE id = $1`,
    [orgId],
  );
  if (!org) return { ok: true };

  const project = projectId
    ? await queryOne<ProjectLimits>(
        `SELECT run_hourly_limit FROM projects WHERE id = $1`,
        [projectId],
      )
    : null;

  // Project hourly rate.
  if (project?.run_hourly_limit != null && projectId) {
    const lastHour = await count(
      `SELECT count(*)::int AS n FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id
        JOIN sessions s ON s.id = r.session_id
        WHERE s.project_id = $1 AND t.created_at >= now() - interval '1 hour'`,
      [projectId],
    );
    if (lastHour >= project.run_hourly_limit) {
      return {
        ok: false,
        limit: "project_hourly",
        error: `This project has used its ${project.run_hourly_limit} AI turn(s) for the hour. Try again later.`,
      };
    }
  }

  // Org monthly quota.
  if (org.run_monthly_quota != null) {
    const thisMonth = await count(
      `SELECT count(*)::int AS n FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id
        JOIN sessions s ON s.id = r.session_id
        WHERE s.org_id = $1 AND t.created_at >= date_trunc('month', now())`,
      [orgId],
    );
    if (thisMonth >= org.run_monthly_quota) {
      return {
        ok: false,
        limit: "org_monthly",
        error: `Your organisation has used its ${org.run_monthly_quota} AI turn(s) for this month.`,
      };
    }
  }

  return { ok: true };
}

export type OrgUsage = {
  /** AI turns running across the org right now, on members' computers. Never capped. */
  concurrency: { used: number };
  monthly: { used: number; limit: number | null };
};

/** A snapshot of an org's pooled usage against its limits, for the UI. */
export async function orgUsage(orgId: string): Promise<OrgUsage> {
  const limits = await queryOne<OrgLimits>(
    `SELECT run_monthly_quota FROM orgs WHERE id = $1`,
    [orgId],
  );
  const running = await count(
    `SELECT count(*)::int AS n FROM agent_runs r JOIN sessions s ON s.id = r.session_id
      WHERE s.org_id = $1 AND r.status = 'running'
        AND r.started_at > now() - interval '${STALE}'`,
    [orgId],
  );
  const monthly = await count(
    `SELECT count(*)::int AS n FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id
      JOIN sessions s ON s.id = r.session_id
      WHERE s.org_id = $1 AND t.created_at >= date_trunc('month', now())`,
    [orgId],
  );
  return {
    concurrency: { used: running },
    monthly: { used: monthly, limit: limits?.run_monthly_quota ?? null },
  };
}
