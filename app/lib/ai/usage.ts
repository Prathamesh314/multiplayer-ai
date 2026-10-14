import { queryOne } from "../db/client";
import { DEFAULT_PARALLEL_CHATS, type RunIsolation } from "./isolation";

/**
 * The cost governor for AI runs.
 *
 * A run is a spawned coding agent — real compute and real rate limits — so
 * before one starts we check it against pooled, org-level limits and a tighter
 * per-project throttle. Concurrency is counted over a staleness window so a run
 * whose server died mid-flight stops counting instead of wedging the pool.
 */

// Longer than MAX_RUN_MS (10 min) in the run route: a "running" row older than
// this is stale — its process is gone — and must not hold a concurrency slot.
const STALE = "15 minutes";

export type RunGate = { ok: true } | { ok: false; error: string; limit: string };

type OrgLimits = { run_concurrency_limit: number; run_monthly_quota: number | null };
type ProjectLimits = { run_concurrency_limit: number | null; run_hourly_limit: number | null };

async function count(sql: string, params: unknown[]): Promise<number> {
  const row = await queryOne<{ n: number }>(sql, params);
  return row?.n ?? 0;
}

/**
 * Decides whether a run may start. Concurrency guards apply to every run (a live
 * process is a live process). Period limits count accepted execution turns,
 * including continuations. This is a preflight for friendly errors; reserveTurn
 * repeats the checks atomically before admitting work.
 */
export async function checkRunAllowed(params: {
  orgId: string | null;
  projectId: string | null;
  sessionId: string;
  userId: string;
  isNewRun: boolean;
  /** A new isolated chat is bounded per person instead of per room. */
  isolation?: RunIsolation;
}): Promise<RunGate> {
  const { orgId, projectId, sessionId, userId, isNewRun } = params;

  // Isolated chats have their own branches, so several may run at once; the
  // cap protects the member's machine and spans every room.
  if (isNewRun && params.isolation === "isolated") {
    const limit = (orgId ? (await queryOne<{ n: number }>(
      `SELECT parallel_chats_per_user AS n FROM orgs WHERE id = $1`, [orgId]))?.n : null) ?? DEFAULT_PARALLEL_CHATS;
    const parallel = await count(
      `SELECT count(*)::int AS n FROM agent_runs
        WHERE driver_user_id = $1 AND status = 'running' AND isolation = 'isolated'
          AND started_at > now() - interval '${STALE}'`,
      [userId],
    );
    if (parallel >= limit) {
      return {
        ok: false,
        limit: "parallel",
        error: `You already have ${limit} parallel chat(s) running. Wait for one to finish.`,
      };
    }
  }

  // One live shared run per person per room. Watchers share a run's stream, so a second
  // simultaneous run by the same user is duplicated compute, not collaboration.
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
        error: "You already have a run going in this room — watch it or wait for it to finish.",
      };
    }
  }

  // Personal rooms (no org) are governed only by the personal guards above.
  if (!orgId) return { ok: true };

  const org = await queryOne<OrgLimits>(
    `SELECT run_concurrency_limit, run_monthly_quota FROM orgs WHERE id = $1`,
    [orgId],
  );
  if (!org) return { ok: true };

  const project = projectId
    ? await queryOne<ProjectLimits>(
        `SELECT run_concurrency_limit, run_hourly_limit FROM projects WHERE id = $1`,
        [projectId],
      )
    : null;

  // Project concurrency (tighter than the org's, when set).
  if (project?.run_concurrency_limit != null && projectId) {
    const running = await count(
      `SELECT count(*)::int AS n FROM agent_runs r JOIN sessions s ON s.id = r.session_id
        WHERE s.project_id = $1 AND r.status = 'running'
          AND r.started_at > now() - interval '${STALE}'`,
      [projectId],
    );
    if (running >= project.run_concurrency_limit) {
      return {
        ok: false,
        limit: "project_concurrency",
        error: `This project allows ${project.run_concurrency_limit} agent run(s) at once, and they're all busy. Try again shortly.`,
      };
    }
  }

  // Org concurrency — the pooled compute cap.
  const orgRunning = await count(
    `SELECT count(*)::int AS n FROM agent_runs r JOIN sessions s ON s.id = r.session_id
      WHERE s.org_id = $1 AND r.status = 'running'
        AND r.started_at > now() - interval '${STALE}'`,
    [orgId],
  );
  if (orgRunning >= org.run_concurrency_limit) {
    return {
      ok: false,
      limit: "org_concurrency",
      error: `Your organisation is at its limit of ${org.run_concurrency_limit} agent run(s) at once. Wait for one to finish.`,
    };
  }

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
  concurrency: { used: number; limit: number };
  monthly: { used: number; limit: number | null };
};

/** A snapshot of an org's pooled usage against its limits, for the UI. */
export async function orgUsage(orgId: string): Promise<OrgUsage> {
  const limits = await queryOne<OrgLimits>(
    `SELECT run_concurrency_limit, run_monthly_quota FROM orgs WHERE id = $1`,
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
    concurrency: { used: running, limit: limits?.run_concurrency_limit ?? 0 },
    monthly: { used: monthly, limit: limits?.run_monthly_quota ?? null },
  };
}
