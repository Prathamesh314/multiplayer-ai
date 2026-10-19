"use client";

/*
 * The operator dashboard: platform health and growth at a glance, in the
 * style of Vercel's and Supabase's consoles. Sections in a sidebar; KPI cards
 * compare the last 7 days with the 7 before; charts are plain SVG; tables
 * search, sort and export to CSV. Data is loaded on the server per request.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminDashboard as Data, DayPoint, Kpi } from "../../lib/admin/dashboard";
import { humanBytes, relativeTime } from "../../lib/format";
import { ComputerIcon, ShieldIcon, SparkleIcon, UsersIcon } from "../icons";

type Section = "overview" | "users" | "orgs" | "ai" | "computers" | "health" | "security";
const SECTIONS: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <Glyph d="M3 13V8M8 13V3M13 13v-7" /> },
  { id: "users", label: "Users", icon: <UsersIcon className="h-4 w-4" /> },
  { id: "orgs", label: "Organisations", icon: <Glyph d="M2.5 13.5h11M4 13.5V4.5l4-2 4 2v9M6.5 7h3M6.5 9.5h3" /> },
  { id: "ai", label: "AI usage", icon: <SparkleIcon className="h-4 w-4" /> },
  { id: "computers", label: "Computers", icon: <ComputerIcon className="h-4 w-4" /> },
  { id: "health", label: "System health", icon: <Glyph d="M1.5 8h3l1.5-4 3 8 1.5-4h4" /> },
  { id: "security", label: "Admin activity", icon: <ShieldIcon className="h-4 w-4" /> },
];

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en");
const ago = (at: string | null) => (at ? relativeTime(new Date(at).getTime() / 1000) : "—");
const seconds = (value: number | null) => value == null ? "—" : value < 60 ? `${Math.round(value)}s` : value < 3600 ? `${Math.round(value / 60)}m` : `${(value / 3600).toFixed(1)}h`;

export function AdminDashboard({ data, admin }: { data: Data; admin: { email: string; name: string } }) {
  const router = useRouter();
  const [section, setSection] = useState<Section>("overview");
  const [refreshing, setRefreshing] = useState(false);
  const [auto, setAuto] = useState(false);

  useEffect(() => { try { const saved = sessionStorage.getItem("admin:section"); if (saved && SECTIONS.some((s) => s.id === saved)) void Promise.resolve().then(() => setSection(saved as Section)); } catch { /* storage unavailable */ } }, []);
  function choose(next: Section) { setSection(next); try { sessionStorage.setItem("admin:section", next); } catch { /* storage unavailable */ } }

  // A fresh render from the server; the timestamp changing is how we know it landed.
  function refresh() { setRefreshing(true); router.refresh(); }
  useEffect(() => { void Promise.resolve().then(() => setRefreshing(false)); }, [data.generatedAt]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => { if (!document.hidden) router.refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [auto, router]);

  async function signOut() {
    await fetch("/api/admin/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/admin/login");
  }

  const alerts = healthAlerts(data);
  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-vs-border bg-vs-chrome/60 md:flex">
        <div className="flex items-center gap-2.5 px-4 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-vs-accent/15 text-vs-accent"><ShieldIcon className="h-4 w-4" /></span>
          <div className="min-w-0"><p className="text-sm font-semibold leading-tight">Multicode AI</p><p className="text-[11px] text-vs-muted">Admin console</p></div>
        </div>
        <nav aria-label="Admin sections" className="flex-1 space-y-0.5 px-2">
          {SECTIONS.map((item) => (
            <button key={item.id} type="button" onClick={() => choose(item.id)} aria-current={section === item.id ? "page" : undefined}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition ${section === item.id ? "bg-vs-active font-medium text-vs-fg" : "text-vs-muted hover:bg-vs-hover hover:text-vs-fg"}`}>
              <span className="text-current">{item.icon}</span>{item.label}
              {item.id === "health" && alerts.length > 0 && <span className="ml-auto rounded-full bg-vs-warn/15 px-1.5 text-[10px] font-semibold text-vs-warn">{alerts.length}</span>}
            </button>
          ))}
        </nav>
        <div className="border-t border-vs-border p-3">
          <p className="truncate text-xs font-medium">{admin.name}</p>
          <p className="truncate text-[11px] text-vs-muted">{admin.email}</p>
          <div className="mt-2 flex gap-1.5">
            <a href="/admin/password" className="flex-1 rounded-md border border-vs-border px-2 py-1 text-center text-[11px] text-vs-muted hover:text-vs-fg">Password</a>
            <button type="button" onClick={() => void signOut()} className="flex-1 rounded-md border border-vs-border px-2 py-1 text-[11px] text-vs-muted hover:text-vs-fg">Sign out</button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 border-b border-vs-border bg-vs-editor/85 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
            <h1 className="text-base font-semibold tracking-tight">{SECTIONS.find((item) => item.id === section)?.label}</h1>
            <span className="text-xs text-vs-muted">Updated {ago(data.generatedAt)}</span>
            <div className="ml-auto flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-vs-muted"><input type="checkbox" checked={auto} onChange={(event) => setAuto(event.target.checked)} className="h-3 w-3 accent-vs-accent" /> Auto-refresh</label>
              <button type="button" onClick={refresh} disabled={refreshing} className="flex items-center gap-1.5 rounded-lg border border-vs-border px-2.5 py-1 text-xs hover:bg-vs-hover disabled:opacity-60">
                <Glyph d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
              </button>
              <button type="button" onClick={() => void signOut()} className="rounded-lg border border-vs-border px-2.5 py-1 text-xs hover:bg-vs-hover md:hidden">Sign out</button>
            </div>
          </div>
          <nav aria-label="Admin sections" className="vs-scroll flex gap-1 overflow-x-auto px-3 pb-2 md:hidden">
            {SECTIONS.map((item) => (
              <button key={item.id} type="button" onClick={() => choose(item.id)} className={`shrink-0 rounded-md px-2.5 py-1 text-xs ${section === item.id ? "bg-vs-active text-vs-fg" : "text-vs-muted"}`}>{item.label}</button>
            ))}
          </nav>
        </header>

        <main className="mx-auto max-w-7xl space-y-5 px-4 py-5 sm:px-6">
          {section === "overview" && <Overview data={data} alerts={alerts} onSection={choose} />}
          {section === "users" && <UsersSection data={data} />}
          {section === "orgs" && <OrgsSection data={data} />}
          {section === "ai" && <AiSection data={data} />}
          {section === "computers" && <ComputersSection data={data} />}
          {section === "health" && <HealthSection data={data} alerts={alerts} />}
          {section === "security" && <SecuritySection data={data} />}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Overview({ data, alerts, onSection }: { data: Data; alerts: Alert[]; onSection: (section: Section) => void }) {
  const k = data.kpis;
  const turnsTotal = data.turns.map((point) => sum(point.values));
  return (
    <>
      {alerts.length > 0 && (
        <button type="button" onClick={() => onSection("health")} className="flex w-full items-center gap-2 rounded-xl border border-vs-warn/40 bg-vs-warn/10 px-4 py-2.5 text-left text-sm">
          <span className="h-2 w-2 rounded-full bg-vs-warn" />
          <span className="font-medium">{alerts.length} {alerts.length === 1 ? "thing needs" : "things need"} attention</span>
          <span className="hidden truncate text-vs-muted sm:inline">· {alerts[0].title}</span>
          <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-vs-muted">View health →</span>
        </button>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Total users" kpi={k.users} spark={data.signups.map((p) => p.values.signups ?? 0)} hint="vs. 7 days ago" />
        <KpiCard label="New users · 7d" kpi={k.newUsers7d} hint="vs. previous 7 days" />
        <KpiCard label="Active users · 7d" kpi={k.activeUsers7d} hint="sent an AI message" />
        <KpiCard label="AI turns · 7d" kpi={k.turns7d} spark={turnsTotal} />
        <KpiCard label="Turn success · 7d" kpi={k.successRate7d} format={(v) => `${v}%`} absoluteDelta />
        <KpiCard label="Lines changed · 7d" kpi={k.linesChanged7d} />
        <KpiCard label="Organisations" kpi={k.orgs} hint="vs. 7 days ago" />
        <KpiCard label="Computers online" kpi={k.computersOnline} footer={`${whole.format(k.computers.value)} paired`} live={k.computersOnline.value > 0} />
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card title="AI turns" subtitle="Last 30 days" className="lg:col-span-2">
          <StackedBars points={data.turns} keys={[["completed", "bg-vs-success", "Completed"], ["failed", "bg-vs-danger", "Failed"], ["other", "bg-vs-muted/50", "Running or cancelled"]]} />
        </Card>
        <Card title="Sign-ups" subtitle="Last 30 days">
          <StackedBars points={data.signups} keys={[["signups", "bg-vs-accent", "Sign-ups"]]} />
        </Card>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card title="Platform" subtitle="Everything people have made">
          <Stat label="Projects" value={k.projects.value} delta={k.projects} />
          <Stat label="Rooms" value={k.rooms.value} delta={k.rooms} />
          <Stat label="Chats" value={k.chats.value} delta={k.chats} />
          <Stat label="Open tasks" value={data.health.openTasks} />
          <Stat label="Pending handoffs" value={data.health.pendingHandoffs} />
        </Card>
        <Card title="Agents" subtitle="Turns in the last 30 days">
          <Donut slices={data.agents.map((agent) => ({ label: agent.agent, value: agent.turns }))} />
        </Card>
        <Card title="Newest users" subtitle="Most recent sign-ups" action={<LinkButton onClick={() => onSection("users")}>All users →</LinkButton>}>
          <ul className="divide-y divide-vs-border">
            {data.users.slice(0, 6).map((user) => (
              <li key={user.id} className="flex items-center gap-2.5 py-2">
                <Avatar name={user.name ?? user.email} />
                <div className="min-w-0 flex-1"><p className="truncate text-[13px]">{user.name ?? user.handle}</p><p className="truncate text-[11px] text-vs-muted">{user.email}</p></div>
                <span className="shrink-0 text-[11px] text-vs-muted">{ago(user.createdAt)}</span>
              </li>
            ))}
            {data.users.length === 0 && <Empty>No users yet.</Empty>}
          </ul>
        </Card>
      </div>
    </>
  );
}

function UsersSection({ data }: { data: Data }) {
  const states = { active: "bg-vs-success/15 text-vs-success", invited: "bg-vs-muted/15 text-vs-muted", disabled: "bg-vs-warn/15 text-vs-warn", deleted: "bg-vs-danger/15 text-vs-danger" };
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Total users" kpi={data.kpis.users} hint="vs. 7 days ago" />
        <KpiCard label="New · 7d" kpi={data.kpis.newUsers7d} />
        <KpiCard label="Active · 7d" kpi={data.kpis.activeUsers7d} />
        <KpiCard label="With a computer" kpi={{ value: data.users.filter((user) => user.computers > 0).length }} />
      </div>
      <Table
        title="Users" rows={data.users} searchKeys={["email", "name", "handle"]} csv="users"
        columns={[
          { key: "email", label: "User", render: (user) => <div className="flex items-center gap-2.5"><Avatar name={user.name ?? user.email} /><div className="min-w-0"><p className="truncate font-medium">{user.name ?? user.handle}</p><p className="truncate text-[11px] text-vs-muted">{user.email}</p></div></div> },
          { key: "state", label: "Status", render: (user) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${states[user.state]}`}>{user.state}</span> },
          { key: "orgs", label: "Orgs", numeric: true },
          { key: "turns30d", label: "AI turns · 30d", numeric: true },
          { key: "computers", label: "Computers", numeric: true },
          { key: "lastActiveAt", label: "Last active", render: (user) => ago(user.lastActiveAt) },
          { key: "createdAt", label: "Joined", render: (user) => ago(user.createdAt) },
        ]}
      />
    </>
  );
}

function OrgsSection({ data }: { data: Data }) {
  return (
    <Table
      title="Organisations" rows={data.orgs} searchKeys={["name", "slug", "owner"]} csv="organisations"
      columns={[
        { key: "name", label: "Organisation", render: (org) => <div className="flex items-center gap-2.5"><Avatar name={org.name} square /><div className="min-w-0"><p className="truncate font-medium">{org.name}</p><p className="truncate text-[11px] text-vs-muted">/{org.slug}</p></div></div> },
        { key: "owner", label: "Created by", render: (org) => <span className="text-vs-muted">{org.owner ?? "—"}</span> },
        { key: "members", label: "Members", numeric: true },
        { key: "projects", label: "Projects", numeric: true },
        { key: "rooms", label: "Rooms", numeric: true },
        { key: "turns30d", label: "AI turns · 30d", numeric: true },
        { key: "lastActiveAt", label: "Last active", render: (org) => ago(org.lastActiveAt) },
        { key: "createdAt", label: "Created", render: (org) => ago(org.createdAt) },
      ]}
    />
  );
}

function AiSection({ data }: { data: Data }) {
  const total = sum(Object.fromEntries(data.turnStatus.map((row) => [row.status, row.count])));
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="AI turns · 7d" kpi={data.kpis.turns7d} />
        <KpiCard label="Success rate · 7d" kpi={data.kpis.successRate7d} format={(v) => `${v}%`} absoluteDelta />
        <KpiCard label="Median turn" kpi={{ value: data.durations.p50 ?? 0 }} format={(v) => seconds(v)} footer={`p95 ${seconds(data.durations.p95)}`} />
        <KpiCard label="Lines changed · 7d" kpi={data.kpis.linesChanged7d} />
      </div>
      <Card title="Turns per day" subtitle="Last 30 days, by outcome">
        <StackedBars points={data.turns} height={180} keys={[["completed", "bg-vs-success", "Completed"], ["failed", "bg-vs-danger", "Failed"], ["other", "bg-vs-muted/50", "Running or cancelled"]]} />
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="By agent" subtitle="Last 30 days">
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-[11px] uppercase tracking-wide text-vs-muted"><th className="pb-2 font-medium">Agent</th><th className="pb-2 text-right font-medium">Turns</th><th className="pb-2 text-right font-medium">Failed</th><th className="pb-2 text-right font-medium">People</th></tr></thead>
            <tbody className="divide-y divide-vs-border">
              {data.agents.map((agent) => (
                <tr key={agent.agent}><td className="py-2 font-medium capitalize">{agent.agent}</td><td className="py-2 text-right tabular-nums">{whole.format(agent.turns)}</td>
                  <td className="py-2 text-right tabular-nums text-vs-danger">{agent.failed ? `${whole.format(agent.failed)} · ${Math.round((agent.failed / agent.turns) * 100)}%` : "0"}</td><td className="py-2 text-right tabular-nums">{agent.users}</td></tr>
              ))}
              {data.agents.length === 0 && <tr><td colSpan={4}><Empty>No turns in the last 30 days.</Empty></td></tr>}
            </tbody>
          </table>
        </Card>
        <Card title="Outcomes" subtitle="Last 30 days">
          <Bars rows={data.turnStatus.map((row) => ({ label: row.status, value: row.count, tone: row.status === "completed" ? "bg-vs-success" : row.status === "failed" ? "bg-vs-danger" : "bg-vs-accent" }))} total={total} />
        </Card>
      </div>
      <FailuresCard data={data} />
    </>
  );
}

function ComputersSection({ data }: { data: Data }) {
  const latest = data.devices.versions[0]?.version;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Online now" kpi={{ value: data.devices.online }} live={data.devices.online > 0} />
        <KpiCard label="Paired computers" kpi={{ value: data.devices.total }} />
        <KpiCard label="Platforms" kpi={{ value: data.devices.platforms.length }} />
        <KpiCard label="App versions" kpi={{ value: data.devices.versions.length }} footer={latest ? `Most common: v${latest}` : undefined} />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="App versions"><Bars rows={data.devices.versions.map((row) => ({ label: `v${row.version}`, value: row.count, tone: "bg-vs-accent" }))} total={data.devices.total} /></Card>
        <Card title="Platforms"><Bars rows={data.devices.platforms.map((row) => ({ label: row.platform, value: row.count, tone: "bg-sky-500" }))} total={data.devices.total} /></Card>
      </div>
      <Table
        title="Computers" rows={data.devices.recent} searchKeys={["name", "owner", "platform", "version"]} csv="computers"
        columns={[
          { key: "name", label: "Computer", render: (device) => <span className="flex items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${device.online ? "bg-vs-success shadow-[0_0_0_3px] shadow-vs-success/20" : "bg-vs-muted/40"}`} /><span className="font-medium">{device.name}</span></span> },
          { key: "owner", label: "Owner", render: (device) => <span className="text-vs-muted">{device.owner}</span> },
          { key: "platform", label: "Platform" },
          { key: "version", label: "Version", render: (device) => device.version ? `v${device.version}` : "—" },
          { key: "lastSeenAt", label: "Last seen", render: (device) => device.online ? <span className="text-vs-success">Online</span> : ago(device.lastSeenAt) },
        ]}
      />
    </>
  );
}

function HealthSection({ data, alerts }: { data: Data; alerts: Alert[] }) {
  const h = data.health;
  return (
    <>
      <Card title="Status" subtitle={alerts.length ? `${alerts.length} ${alerts.length === 1 ? "issue" : "issues"}` : "All systems normal"}>
        {alerts.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-vs-success"><span className="h-2 w-2 rounded-full bg-vs-success" /> No queue backlog, stuck leases or failure spikes.</p>
        ) : (
          <ul className="space-y-2">{alerts.map((alert) => <li key={alert.title} className="flex gap-2.5 rounded-lg border border-vs-warn/30 bg-vs-warn/5 px-3 py-2 text-sm"><span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-vs-warn" /><div><p className="font-medium">{alert.title}</p><p className="text-xs text-vs-muted">{alert.detail}</p></div></li>)}</ul>
        )}
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Queued AI jobs" value={whole.format(h.queuedJobs)} tone={h.queuedJobs > 20 || (h.oldestQueuedSeconds ?? 0) > 120 ? "warn" : "ok"} detail={h.oldestQueuedSeconds != null ? `Oldest waiting ${seconds(h.oldestQueuedSeconds)}` : "Nothing waiting"} />
        <Tile label="Expired leases" value={whole.format(h.expiredLeases)} tone={h.expiredLeases > 0 ? "warn" : "ok"} detail="Claimed jobs past their lease" />
        <Tile label="Failed turns · 24h" value={whole.format(h.failedTurns24h)} tone={h.failedTurns24h > 10 ? "warn" : "ok"} detail="See recent failures below" />
        <Tile label="Database size" value={humanBytes(h.databaseBytes)} detail="PostgreSQL" />
        <Tile label="Repository storage" value={humanBytes(h.storageBytes)} detail="Git data, accounted" />
        <Tile label="Pending invitations" value={whole.format(h.pendingInvitations)} detail="Organisation invites" />
        <Tile label="Active share links" value={whole.format(h.shareLinks)} detail="Room links not revoked" />
        <Tile label="Integrations" value={whole.format(sum(Object.fromEntries(h.integrations.map((row) => [row.provider, row.count]))))} detail={h.integrations.map((row) => `${row.provider} ${row.count}`).join(" · ") || "None connected"} />
      </div>
      <FailuresCard data={data} />
    </>
  );
}

function SecuritySection({ data }: { data: Data }) {
  const labels: Record<string, [string, string]> = {
    login: ["Signed in", "text-vs-success"], login_failed: ["Wrong password", "text-vs-warn"], locked: ["Locked after failures", "text-vs-danger"],
    logout: ["Signed out", "text-vs-muted"], password_changed: ["Changed password", "text-vs-accent"],
  };
  return (
    <Card title="Admin activity" subtitle="Last 50 events on this console">
      <ul className="divide-y divide-vs-border">
        {data.adminEvents.map((event, index) => (
          <li key={index} className="flex items-center gap-3 py-2 text-[13px]">
            <span className={`w-40 shrink-0 font-medium ${labels[event.action]?.[1] ?? ""}`}>{labels[event.action]?.[0] ?? event.action}</span>
            <span className="min-w-0 flex-1 truncate text-vs-muted">{event.email ?? "unknown"}</span>
            <span className="shrink-0 text-xs text-vs-muted" title={new Date(event.at).toLocaleString()}>{ago(event.at)}</span>
          </li>
        ))}
        {data.adminEvents.length === 0 && <Empty>No admin activity yet.</Empty>}
      </ul>
    </Card>
  );
}

function FailuresCard({ data }: { data: Data }) {
  return (
    <Card title="Recent failures" subtitle="Latest failed AI turns">
      <ul className="divide-y divide-vs-border">
        {data.failures.map((failure, index) => (
          <li key={index} className="py-2.5">
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-vs-muted">
              <span className="rounded bg-vs-danger/10 px-1.5 py-px font-medium capitalize text-vs-danger">{failure.agent}</span>
              <span>{failure.user ?? "unknown user"}</span>{failure.room && <><span>·</span><span className="truncate">{failure.room}</span></>}
              <span className="ml-auto">{ago(failure.at || null)}</span>
            </div>
            <p className="mt-1 line-clamp-2 font-mono text-[12px] text-vs-fg/90">{failure.error}</p>
          </li>
        ))}
        {data.failures.length === 0 && <Empty>No failed turns. 🎉</Empty>}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

type Alert = { title: string; detail: string };
function healthAlerts(data: Data): Alert[] {
  const h = data.health, alerts: Alert[] = [];
  if (h.oldestQueuedSeconds != null && h.oldestQueuedSeconds > 120) alerts.push({ title: "AI jobs are waiting for a computer", detail: `${h.queuedJobs} queued; the oldest has waited ${seconds(h.oldestQueuedSeconds)}. Its owner's computer may be offline.` });
  if (h.expiredLeases > 0) alerts.push({ title: `${h.expiredLeases} claimed ${h.expiredLeases === 1 ? "job has" : "jobs have"} an expired lease`, detail: "A computer took a job and stopped reporting. Recovery reclaims these; many at once suggests a runner problem." });
  if (h.failedTurns24h > 10) alerts.push({ title: `${h.failedTurns24h} failed AI turns in 24 hours`, detail: "Check Recent failures for a common cause." });
  const rate = data.kpis.successRate7d;
  if (data.kpis.turns7d.value >= 20 && rate.value < 80) alerts.push({ title: `Turn success rate is ${rate.value}%`, detail: "Below 80% over the last 7 days." });
  return alerts;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function sum(values: Record<string, number>) { return Object.values(values).reduce((total, value) => total + value, 0); }

function Card({ title, subtitle, action, className = "", children }: { title: string; subtitle?: string; action?: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <section className={`rounded-2xl border border-vs-border bg-vs-panel p-4 ${className}`}>
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{title}</h2>{subtitle && <p className="text-xs text-vs-muted">{subtitle}</p>}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

function KpiCard({ label, kpi, format = (v) => compact.format(v), hint, footer, spark, live, absoluteDelta }: { label: string; kpi: Kpi; format?: (value: number) => string; hint?: string; footer?: string; spark?: number[]; live?: boolean; absoluteDelta?: boolean }) {
  const delta = kpi.previous === undefined ? null : absoluteDelta ? kpi.value - kpi.previous : kpi.previous === 0 ? (kpi.value > 0 ? 100 : 0) : ((kpi.value - kpi.previous) / kpi.previous) * 100;
  return (
    <div className="relative overflow-hidden rounded-2xl border border-vs-border bg-vs-panel p-4">
      <p className="flex items-center gap-1.5 text-xs text-vs-muted">{live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-vs-success" />}{label}</p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{format(kpi.value)}</p>
      <div className="mt-1 flex items-center gap-1.5 text-[11px]">
        {delta !== null && Number.isFinite(delta) && (
          <span className={`shrink-0 whitespace-nowrap rounded px-1 py-px font-medium tabular-nums ${delta > 0 ? "bg-vs-success/12 text-vs-success" : delta < 0 ? "bg-vs-danger/12 text-vs-danger" : "bg-vs-muted/12 text-vs-muted"}`}>
            {delta > 0 ? "↑" : delta < 0 ? "↓" : "→"} {Math.abs(Math.round(delta * 10) / 10)}{absoluteDelta ? " pts" : "%"}
          </span>
        )}
        <span className="truncate text-vs-muted">{footer ?? hint ?? (delta !== null ? "vs. previous 7 days" : "")}</span>
      </div>
      {spark && spark.some((value) => value > 0) && <Sparkline values={spark} />}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1), width = 100, height = 28;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * width},${height - (value / max) * (height - 2) - 1}`).join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden className="pointer-events-none absolute bottom-0 right-0 h-8 w-2/5 text-vs-accent opacity-35">
      <polyline points={`0,${height} ${points} ${width},${height}`} fill="currentColor" fillOpacity="0.12" stroke="none" />
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function StackedBars({ points, keys, height = 150 }: { points: DayPoint[]; keys: [string, string, string][]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = points.map((point) => keys.reduce((total, [key]) => total + (point.values[key] ?? 0), 0));
  const max = Math.max(...totals, 1);
  const shown = hover ?? points.length - 1;
  const point = points[shown];
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-vs-muted">
        <span className="font-medium text-vs-fg">{point ? new Date(`${point.day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" }) : ""}</span>
        {keys.map(([key, tone, label]) => <span key={key} className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${tone}`} />{label} <span className="tabular-nums text-vs-fg">{point?.values[key] ?? 0}</span></span>)}
        <span className="ml-auto">Total {whole.format(sum(Object.fromEntries(totals.map((total, index) => [index, total]))))}</span>
      </div>
      <div className="flex items-end gap-[3px]" style={{ height }} onMouseLeave={() => setHover(null)}>
        {points.map((day, index) => (
          <div key={day.day} onMouseEnter={() => setHover(index)} className={`flex h-full flex-1 flex-col-reverse rounded-sm ${hover === index ? "bg-vs-hover" : ""}`} title={day.day}>
            {keys.map(([key, tone]) => {
              const value = day.values[key] ?? 0;
              return value ? <div key={key} className={`${tone} first:rounded-b-sm last:rounded-t-sm`} style={{ height: `${(value / max) * 100}%` }} /> : null;
            })}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-vs-muted"><span>{points[0]?.day.slice(5)}</span><span>Today</span></div>
    </div>
  );
}

const DONUT = ["#d97757", "#10a37f", "#6366f1", "#eab308", "#06b6d4", "#ec4899"];
function Donut({ slices }: { slices: { label: string; value: number }[] }) {
  const total = slices.reduce((all, slice) => all + slice.value, 0);
  if (!total) return <Empty>No AI turns in the last 30 days.</Empty>;
  const radius = 15.9155;
  const shares = slices.map((slice) => (slice.value / total) * 100);
  const offsets = shares.map((_, index) => shares.slice(0, index).reduce((all, share) => all + share, 0));
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 42 42" className="h-32 w-32 shrink-0 -rotate-90" aria-hidden>
        <circle cx="21" cy="21" r={radius} fill="none" stroke="var(--vs-border)" strokeWidth="5" />
        {slices.map((slice, index) => (
          <circle key={slice.label} cx="21" cy="21" r={radius} fill="none" stroke={DONUT[index % DONUT.length]} strokeWidth="5" strokeDasharray={`${shares[index]} ${100 - shares[index]!}`} strokeDashoffset={-offsets[index]!} />
        ))}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1.5 text-[13px]">
        {slices.map((slice, index) => (
          <li key={slice.label} className="flex items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: DONUT[index % DONUT.length] }} /><span className="flex-1 truncate capitalize">{slice.label}</span><span className="tabular-nums text-vs-muted">{Math.round((slice.value / total) * 100)}%</span></li>
        ))}
      </ul>
    </div>
  );
}

function Bars({ rows, total }: { rows: { label: string; value: number; tone: string }[]; total: number }) {
  if (!rows.length) return <Empty>Nothing to show yet.</Empty>;
  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.label}>
          <div className="mb-1 flex text-[12px]"><span className="flex-1 truncate capitalize">{row.label}</span><span className="tabular-nums text-vs-muted">{whole.format(row.value)} · {total ? Math.round((row.value / total) * 100) : 0}%</span></div>
          <div className="h-1.5 overflow-hidden rounded-full bg-vs-border/60"><div className={`h-full rounded-full ${row.tone}`} style={{ width: `${total ? (row.value / total) * 100 : 0}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, delta }: { label: string; value: number; delta?: Kpi }) {
  const added = delta?.previous !== undefined ? value - delta.previous : 0;
  return (
    <div className="flex items-center justify-between border-b border-vs-border py-2 text-[13px] last:border-0">
      <span className="text-vs-muted">{label}</span>
      <span className="flex items-center gap-2 tabular-nums"><span className="font-medium">{whole.format(value)}</span>{added > 0 && <span className="text-[11px] text-vs-success">+{added} this week</span>}</span>
    </div>
  );
}

function Tile({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "ok" | "warn" }) {
  return (
    <div className={`rounded-2xl border bg-vs-panel p-4 ${tone === "warn" ? "border-vs-warn/50" : "border-vs-border"}`}>
      <p className="flex items-center gap-1.5 text-xs text-vs-muted">{tone && <span className={`h-1.5 w-1.5 rounded-full ${tone === "warn" ? "bg-vs-warn" : "bg-vs-success"}`} />}{label}</p>
      <p className="mt-1.5 text-xl font-semibold tabular-nums">{value}</p>
      {detail && <p className="mt-0.5 truncate text-[11px] text-vs-muted" title={detail}>{detail}</p>}
    </div>
  );
}

type Column<T> = { key: keyof T & string; label: string; numeric?: boolean; render?: (row: T) => React.ReactNode };
function Table<T extends Record<string, unknown>>({ title, rows, columns, searchKeys, csv }: { title: string; rows: T[]; columns: Column<T>[]; searchKeys: (keyof T & string)[]; csv: string }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [limit, setLimit] = useState(25);
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = needle ? rows.filter((row) => searchKeys.some((key) => String(row[key] ?? "").toLowerCase().includes(needle))) : rows;
    if (!sort) return filtered;
    return [...filtered].sort((a, b) => {
      const x = a[sort.key], y = b[sort.key];
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sort.dir;
    });
  }, [rows, search, sort, searchKeys]);

  function exportCsv() {
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const text = [columns.map((column) => escape(column.label)).join(","), ...visible.map((row) => columns.map((column) => escape(row[column.key])).join(","))].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    link.download = `multicode-${csv}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-vs-border bg-vs-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-vs-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="rounded-md bg-vs-hover px-1.5 text-[11px] tabular-nums text-vs-muted">{visible.length}</span>
        <div className="ml-auto flex items-center gap-2">
          <input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(25); }} placeholder={`Search ${title.toLowerCase()}…`} aria-label={`Search ${title.toLowerCase()}`}
            className="w-48 rounded-lg border border-vs-border bg-vs-editor px-2.5 py-1 text-xs outline-none placeholder:text-vs-muted focus:border-vs-accent sm:w-64" />
          <button type="button" onClick={exportCsv} className="rounded-lg border border-vs-border px-2.5 py-1 text-xs hover:bg-vs-hover">Export CSV</button>
        </div>
      </div>
      <div className="vs-scroll overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead className="bg-vs-chrome/50">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={`px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-vs-muted ${column.numeric ? "text-right" : "text-left"}`}>
                  <button type="button" onClick={() => setSort((current) => current?.key === column.key ? { key: column.key, dir: current.dir === 1 ? -1 : 1 } : { key: column.key, dir: column.numeric ? -1 : 1 })} className="inline-flex items-center gap-1 hover:text-vs-fg">
                    {column.label}{sort?.key === column.key && <span aria-hidden>{sort.dir === 1 ? "↑" : "↓"}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-vs-border">
            {visible.slice(0, limit).map((row, index) => (
              <tr key={index} className="hover:bg-vs-hover/50">
                {columns.map((column) => (
                  <td key={column.key} className={`max-w-72 px-4 py-2.5 align-middle ${column.numeric ? "text-right tabular-nums" : ""}`}>
                    {column.render ? column.render(row) : column.numeric ? whole.format(Number(row[column.key] ?? 0)) : String(row[column.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <Empty>{search ? `Nothing matches “${search}”.` : "Nothing here yet."}</Empty>}
      </div>
      {visible.length > limit && <button type="button" onClick={() => setLimit(limit + 50)} className="w-full border-t border-vs-border py-2 text-xs text-vs-accent hover:bg-vs-hover">Show more ({visible.length - limit} left)</button>}
    </section>
  );
}

function Avatar({ name, square }: { name: string; square?: boolean }) {
  const initials = name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
  let hash = 0; for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return <span className={`flex h-7 w-7 shrink-0 items-center justify-center text-[10px] font-semibold text-white ${square ? "rounded-lg" : "rounded-full"}`} style={{ background: `hsl(${Math.abs(hash) % 360} 45% 45%)` }}>{initials}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-center text-xs text-vs-muted">{children}</p>;
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className="shrink-0 text-xs text-vs-accent hover:underline">{children}</button>;
}

function Glyph({ d, className = "h-4 w-4" }: { d: string; className?: string }) {
  return <svg viewBox="0 0 16 16" aria-hidden className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}

