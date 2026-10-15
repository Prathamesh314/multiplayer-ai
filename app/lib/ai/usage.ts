import { queryOne } from "../db/client";
import type { RunIsolation } from "./isolation";
import { SERVER_ACTIVE } from "./turns";

/**
 * The cost governor for AI runs.
 *
 * Runs on a member's own computer use that person's machine and AI account,
 * so nothing here caps how many run at once: as in a desktop orchestrator, the
 * person starting them is the limit. Runs on this server share its capacity,
 * so org, project and per-person parallel caps apply to those, and only when
 * an operator has set one (NULL means unlimited). Period quotas apply to all.
 */

// Longer than MAX_RUN_MS (10 min) in the run route: a "running" row older than
// this is stale — its process is gone — and must not hold a concurrency slot.
const STALE = "15 minutes";

export type RunGate = { ok: true } | { ok: false; error: string; limit: string };

type OrgLimits = { run_concurrency_limit: number | null; run_monthly_quota: number | null };
type ProjectLimits = { run_concurrency_limit: number | null; run_hourly_limit: number | null };

async function count(sql: string, params: unknown[]): Promise<number> {
  const row = await queryOne<{ n: number }>(sql, params);
  return row?.n ?? 0;
}

/**
 * Decides whether a run may start. Concurrency caps apply only to runs on this
 * server (`target`), and only when configured. Period limits count accepted
 * execution turns, including continuations. This is a preflight for friendly
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
  /** Where the turn will execute: a member's computer, or this server. */
  target?: "local" | "server";
}): Promise<RunGate> {
  const { orgId, projectId, sessionId, userId, isNewRun } = params;
  const onServer = (params.target ?? "server") === "server";

  // Parallel chats on this server, per person, when an operator caps them.
  if (onServer && isNewRun && params.isolation === "isolated" && orgId) {
    const limit = (await queryOne<{ n: number | null }>(`SELECT parallel_chats_per_user AS n FROM orgs WHERE id = $1`, [orgId]))?.n ?? null;
    const parallel = limit == null ? 0 : await count(
      `SELECT count(*)::int AS n FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id
        WHERE r.driver_user_id = $1 AND r.isolation = 'isolated' AND ${SERVER_ACTIVE}`,
      [userId],
    );
    if (limit != null && parallel >= limit) {
      return {
        ok: false,
        limit: "parallel",
        error: `This server runs up to ${limit} parallel chat(s) per person at once. Wait for one to finish.`,
      };
    }
  }

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

  // Server capacity: project, then org, when an operator has set a cap.
  if (onServer && project?.run_concurrency_limit != null && projectId) {
    const running = await count(
      `SELECT count(*)::int AS n FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id JOIN sessions s ON s.id = r.session_id
        WHERE s.project_id = $1 AND ${SERVER_ACTIVE}`,
      [projectId],
    );
    if (running >= project.run_concurrency_limit) {
      return {
        ok: false,
        limit: "project_concurrency",
        error: `This server runs up to ${project.run_concurrency_limit} AI turn(s) at once for this project, and they're all busy. Try again shortly.`,
      };
    }
  }
  if (onServer && org.run_concurrency_limit != null) {
    const orgRunning = await count(
      `SELECT count(*)::int AS n FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id JOIN sessions s ON s.id = r.session_id
        WHERE s.org_id = $1 AND ${SERVER_ACTIVE}`,
      [orgId],
    );
    if (orgRunning >= org.run_concurrency_limit) {
      return {
        ok: false,
        limit: "org_concurrency",
        error: `This server runs up to ${org.run_concurrency_limit} AI turn(s) at once for your organisation. Wait for one to finish.`,
      };
    }
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
  /**
   * `used`: AI turns running across the org right now, wherever they execute.
   * `limit`: the operator's cap on turns running on this server at once, or
   * null for none. Turns on members' own computers are never capped.
   */
  concurrency: { used: number; limit: number | null };
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
    concurrency: { used: running, limit: limits?.run_concurrency_limit ?? null },
    monthly: { used: monthly, limit: limits?.run_monthly_quota ?? null },
  };
}
