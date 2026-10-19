import { query, queryOne } from "../db/client";
import { DEVICE_ONLINE_MS } from "../runner/devices";

/*
 * Platform-wide numbers for /admin. Read-only, aggregate where it can be, and
 * never any secret: no tokens, credentials, prompts or file contents. Message
 * and error text is limited to the short failure reason of recent turns.
 */

export type Kpi = { value: number; previous?: number };
export type DayPoint = { day: string; values: Record<string, number> };

export type AdminDashboard = {
  generatedAt: string;
  kpis: {
    users: Kpi; newUsers7d: Kpi; activeUsers7d: Kpi; orgs: Kpi; projects: Kpi; rooms: Kpi;
    chats: Kpi; turns7d: Kpi; successRate7d: Kpi; computersOnline: Kpi; computers: Kpi; linesChanged7d: Kpi;
  };
  signups: DayPoint[];
  turns: DayPoint[];
  agents: { agent: string; turns: number; failed: number; users: number }[];
  turnStatus: { status: string; count: number }[];
  durations: { p50: number | null; p95: number | null; average: number | null };
  users: { id: string; email: string; name: string | null; handle: string; createdAt: string; lastActiveAt: string | null; orgs: number; turns30d: number; computers: number; state: "active" | "invited" | "disabled" | "deleted" }[];
  orgs: { id: string; name: string; slug: string; createdAt: string; owner: string | null; members: number; projects: number; rooms: number; turns30d: number; lastActiveAt: string | null }[];
  devices: { online: number; total: number; versions: { version: string; count: number }[]; platforms: { platform: string; count: number }[]; recent: { name: string; owner: string; platform: string | null; version: string | null; lastSeenAt: string | null; online: boolean }[] };
  health: {
    databaseBytes: number; storageBytes: number; queuedJobs: number; oldestQueuedSeconds: number | null; expiredLeases: number;
    failedTurns24h: number; pendingInvitations: number; pendingHandoffs: number; openTasks: number; shareLinks: number;
    integrations: { provider: string; count: number }[];
  };
  failures: { at: string; agent: string; user: string | null; room: string | null; error: string }[];
  adminEvents: { at: string; email: string | null; action: string }[];
};

const n = (value: unknown) => Number(value ?? 0);
const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);

/** 30 days ending today (UTC), oldest first, with zeros for quiet days. */
function series(rows: { day: string; key: string; count: string | number }[], keys: string[]): DayPoint[] {
  const days: DayPoint[] = [];
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  for (let offset = 29; offset >= 0; offset--) {
    const day = new Date(today.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    days.push({ day, values: Object.fromEntries(keys.map((key) => [key, 0])) });
  }
  const index = new Map(days.map((point) => [point.day, point]));
  for (const row of rows) {
    const point = index.get(String(row.day).slice(0, 10));
    if (point) point.values[row.key] = (point.values[row.key] ?? 0) + n(row.count);
  }
  return days;
}

export async function loadDashboard(): Promise<AdminDashboard> {
  const onlineSeconds = DEVICE_ONLINE_MS / 1000;
  const [counts, signupRows, turnRows, agents, statuses, durations, users, orgs, deviceRows, versions, platforms, health, integrations, failures, adminEvents] = await Promise.all([
    queryOne<Record<string, string>>(`SELECT
        (SELECT count(*) FROM users WHERE deleted_at IS NULL) AS users,
        (SELECT count(*) FROM users WHERE deleted_at IS NULL AND created_at < now() - interval '7 days') AS users_before,
        (SELECT count(*) FROM users WHERE created_at >= now() - interval '7 days') AS new_users,
        (SELECT count(*) FROM users WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days') AS new_users_prev,
        (SELECT count(DISTINCT driver_user_id) FROM agent_turns WHERE created_at >= now() - interval '7 days') AS active_users,
        (SELECT count(DISTINCT driver_user_id) FROM agent_turns WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days') AS active_users_prev,
        (SELECT count(*) FROM orgs WHERE deleted_at IS NULL) AS orgs,
        (SELECT count(*) FROM orgs WHERE deleted_at IS NULL AND created_at < now() - interval '7 days') AS orgs_before,
        (SELECT count(*) FROM projects WHERE archived_at IS NULL) AS projects,
        (SELECT count(*) FROM projects WHERE archived_at IS NULL AND created_at < now() - interval '7 days') AS projects_before,
        (SELECT count(*) FROM sessions WHERE deleted_at IS NULL) AS rooms,
        (SELECT count(*) FROM sessions WHERE deleted_at IS NULL AND created_at < now() - interval '7 days') AS rooms_before,
        (SELECT count(*) FROM agent_runs) AS chats,
        (SELECT count(*) FROM agent_runs WHERE created_at < now() - interval '7 days') AS chats_before,
        (SELECT count(*) FROM agent_turns WHERE created_at >= now() - interval '7 days') AS turns,
        (SELECT count(*) FROM agent_turns WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days') AS turns_prev,
        (SELECT count(*) FILTER (WHERE status = 'completed') FROM agent_turns WHERE created_at >= now() - interval '7 days' AND status IN ('completed','failed')) AS ok,
        (SELECT count(*) FROM agent_turns WHERE created_at >= now() - interval '7 days' AND status IN ('completed','failed')) AS finished,
        (SELECT count(*) FILTER (WHERE status = 'completed') FROM agent_turns WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days' AND status IN ('completed','failed')) AS ok_prev,
        (SELECT count(*) FROM agent_turns WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days' AND status IN ('completed','failed')) AS finished_prev,
        (SELECT count(*) FROM runner_devices WHERE revoked_at IS NULL AND last_seen_at > now() - make_interval(secs => $1)) AS online,
        (SELECT count(*) FROM runner_devices WHERE revoked_at IS NULL) AS devices,
        (SELECT coalesce(sum(coalesce(added_lines,0) + coalesce(removed_lines,0)), 0) FROM agent_runs WHERE ended_at >= now() - interval '7 days') AS lines,
        (SELECT coalesce(sum(coalesce(added_lines,0) + coalesce(removed_lines,0)), 0) FROM agent_runs WHERE ended_at >= now() - interval '14 days' AND ended_at < now() - interval '7 days') AS lines_prev`, [onlineSeconds]),
    query<{ day: string; key: string; count: string }>(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, 'signups' AS key, count(*) AS count
        FROM users WHERE created_at >= now() - interval '30 days' GROUP BY 1`),
    query<{ day: string; key: string; count: string }>(`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        CASE WHEN status = 'completed' THEN 'completed' WHEN status = 'failed' THEN 'failed' ELSE 'other' END AS key, count(*) AS count
        FROM agent_turns WHERE created_at >= now() - interval '30 days' GROUP BY 1, 2`),
    query<{ agent: string; turns: string; failed: string; users: string }>(`SELECT coalesce(r.agent_id, 'unknown') AS agent, count(*) AS turns,
        count(*) FILTER (WHERE t.status = 'failed') AS failed, count(DISTINCT t.driver_user_id) AS users
        FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id WHERE t.created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`),
    query<{ status: string; count: string }>(`SELECT status, count(*) AS count FROM agent_turns WHERE created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC`),
    queryOne<{ p50: number | null; p95: number | null; average: number | null }>(`SELECT
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ended_at - created_at)) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM ended_at - created_at)) AS p95,
        avg(extract(epoch FROM ended_at - created_at)) AS average
        FROM agent_turns WHERE status = 'completed' AND ended_at IS NOT NULL AND created_at >= now() - interval '30 days'`),
    query<{ id: string; email: string; display_name: string | null; handle: string; created_at: Date; last_active: Date | null; orgs: string; turns: string; computers: string; deleted_at: Date | null; clerk_disabled_at: Date | null; onboarded_at: Date | null }>(`SELECT u.id, u.email, u.display_name, u.handle, u.created_at, u.deleted_at, u.clerk_disabled_at, u.onboarded_at,
        greatest((SELECT max(created_at) FROM agent_turns WHERE driver_user_id = u.id), (SELECT max(last_active_at) FROM sessions WHERE owner_id = u.id)) AS last_active,
        (SELECT count(*) FROM org_members WHERE user_id = u.id AND status = 'active') AS orgs,
        (SELECT count(*) FROM agent_turns WHERE driver_user_id = u.id AND created_at >= now() - interval '30 days') AS turns,
        (SELECT count(*) FROM runner_devices WHERE user_id = u.id AND revoked_at IS NULL) AS computers
        FROM users u ORDER BY u.created_at DESC LIMIT 500`),
    query<{ id: string; name: string; slug: string; created_at: Date; owner: string | null; members: string; projects: string; rooms: string; turns: string; last_active: Date | null }>(`SELECT o.id, o.name, o.slug, o.created_at,
        (SELECT email FROM users WHERE id = o.created_by) AS owner,
        (SELECT count(*) FROM org_members WHERE org_id = o.id AND status = 'active') AS members,
        (SELECT count(*) FROM projects WHERE org_id = o.id AND archived_at IS NULL) AS projects,
        (SELECT count(*) FROM sessions WHERE org_id = o.id AND deleted_at IS NULL) AS rooms,
        (SELECT count(*) FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id JOIN sessions s ON s.id = r.session_id WHERE s.org_id = o.id AND t.created_at >= now() - interval '30 days') AS turns,
        (SELECT max(last_active_at) FROM sessions WHERE org_id = o.id) AS last_active
        FROM orgs o WHERE o.deleted_at IS NULL ORDER BY o.created_at DESC LIMIT 500`),
    query<{ name: string; owner: string; platform: string | null; version: string | null; last_seen_at: Date | null; online: boolean }>(`SELECT d.name, u.email AS owner, d.platform, d.version, d.last_seen_at,
        coalesce(d.last_seen_at > now() - make_interval(secs => $1), false) AS online
        FROM runner_devices d JOIN users u ON u.id = d.user_id WHERE d.revoked_at IS NULL
        ORDER BY d.last_seen_at DESC NULLS LAST LIMIT 100`, [onlineSeconds]),
    query<{ version: string; count: string }>(`SELECT coalesce(version, 'unknown') AS version, count(*) AS count FROM runner_devices WHERE revoked_at IS NULL GROUP BY 1 ORDER BY 2 DESC`),
    query<{ platform: string; count: string }>(`SELECT coalesce(platform, 'unknown') AS platform, count(*) AS count FROM runner_devices WHERE revoked_at IS NULL GROUP BY 1 ORDER BY 2 DESC`),
    queryOne<Record<string, string | null>>(`SELECT
        pg_database_size(current_database()) AS database_bytes,
        (SELECT coalesce(sum(bytes), 0) FROM storage_usage) AS storage_bytes,
        (SELECT count(*) FROM runner_jobs WHERE status = 'queued') AS queued,
        (SELECT extract(epoch FROM now() - min(created_at)) FROM runner_jobs WHERE status = 'queued') AS oldest,
        (SELECT count(*) FROM runner_jobs WHERE status = 'claimed' AND lease_expires_at < now()) AS expired,
        (SELECT count(*) FROM agent_turns WHERE status = 'failed' AND created_at >= now() - interval '24 hours') AS failed,
        (SELECT count(*) FROM org_invitations WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS invitations,
        (SELECT count(*) FROM run_handoffs WHERE status = 'pending') AS handoffs,
        (SELECT count(*) FROM room_tasks WHERE status IN ('open','in_progress')) AS tasks,
        (SELECT count(*) FROM session_share_links WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS share_links`),
    query<{ provider: string; count: string }>(`SELECT provider, count(*) AS count FROM context_connections GROUP BY 1 ORDER BY 2 DESC`),
    query<{ at: Date; agent: string; user_email: string | null; room: string | null; error: string | null }>(`SELECT t.ended_at AS at, coalesce(r.agent_id, 'unknown') AS agent, u.email AS user_email, s.name AS room,
        left(coalesce(t.result->>'error', t.recovery_error, r.error, 'Failed'), 240) AS error
        FROM agent_turns t JOIN agent_runs r ON r.id = t.run_id LEFT JOIN users u ON u.id = t.driver_user_id LEFT JOIN sessions s ON s.id = r.session_id
        WHERE t.status = 'failed' ORDER BY coalesce(t.ended_at, t.created_at) DESC LIMIT 25`),
    query<{ created_at: Date; email: string | null; action: string }>(`SELECT created_at, email, action FROM platform_admin_events ORDER BY created_at DESC LIMIT 50`),
  ]);

  const c = counts ?? {};
  const rate = (ok: unknown, total: unknown) => (n(total) ? Math.round((n(ok) / n(total)) * 1000) / 10 : 0);
  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      users: { value: n(c.users), previous: n(c.users_before) },
      newUsers7d: { value: n(c.new_users), previous: n(c.new_users_prev) },
      activeUsers7d: { value: n(c.active_users), previous: n(c.active_users_prev) },
      orgs: { value: n(c.orgs), previous: n(c.orgs_before) },
      projects: { value: n(c.projects), previous: n(c.projects_before) },
      rooms: { value: n(c.rooms), previous: n(c.rooms_before) },
      chats: { value: n(c.chats), previous: n(c.chats_before) },
      turns7d: { value: n(c.turns), previous: n(c.turns_prev) },
      successRate7d: { value: rate(c.ok, c.finished), previous: n(c.finished_prev) ? rate(c.ok_prev, c.finished_prev) : undefined },
      computersOnline: { value: n(c.online) },
      computers: { value: n(c.devices) },
      linesChanged7d: { value: n(c.lines), previous: n(c.lines_prev) },
    },
    signups: series(signupRows, ["signups"]),
    turns: series(turnRows, ["completed", "failed", "other"]),
    agents: agents.map((row) => ({ agent: row.agent, turns: n(row.turns), failed: n(row.failed), users: n(row.users) })),
    turnStatus: statuses.map((row) => ({ status: row.status, count: n(row.count) })),
    durations: { p50: durations?.p50 ?? null, p95: durations?.p95 ?? null, average: durations?.average == null ? null : Number(durations.average) },
    users: users.map((row) => ({
      id: row.id, email: row.email, name: row.display_name, handle: row.handle, createdAt: iso(row.created_at)!, lastActiveAt: iso(row.last_active),
      orgs: n(row.orgs), turns30d: n(row.turns), computers: n(row.computers),
      state: row.deleted_at ? "deleted" : row.clerk_disabled_at ? "disabled" : row.onboarded_at ? "active" : "invited",
    })),
    orgs: orgs.map((row) => ({ id: row.id, name: row.name, slug: row.slug, createdAt: iso(row.created_at)!, owner: row.owner, members: n(row.members), projects: n(row.projects), rooms: n(row.rooms), turns30d: n(row.turns), lastActiveAt: iso(row.last_active) })),
    devices: {
      online: n(c.online), total: n(c.devices),
      versions: versions.map((row) => ({ version: row.version, count: n(row.count) })),
      platforms: platforms.map((row) => ({ platform: row.platform, count: n(row.count) })),
      recent: deviceRows.map((row) => ({ name: row.name, owner: row.owner, platform: row.platform, version: row.version, lastSeenAt: iso(row.last_seen_at), online: row.online })),
    },
    health: {
      databaseBytes: n(health?.database_bytes), storageBytes: n(health?.storage_bytes), queuedJobs: n(health?.queued),
      oldestQueuedSeconds: health?.oldest == null ? null : Math.round(n(health.oldest)), expiredLeases: n(health?.expired), failedTurns24h: n(health?.failed),
      pendingInvitations: n(health?.invitations), pendingHandoffs: n(health?.handoffs), openTasks: n(health?.tasks), shareLinks: n(health?.share_links),
      integrations: integrations.map((row) => ({ provider: row.provider, count: n(row.count) })),
    },
    failures: failures.map((row) => ({ at: iso(row.at) ?? "", agent: row.agent, user: row.user_email, room: row.room, error: row.error ?? "Failed" })),
    adminEvents: adminEvents.map((row) => ({ at: iso(row.created_at)!, email: row.email, action: row.action })),
  };
}
