"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMe, logout } from "../../lib/auth/client";
import type { CurrentUser } from "../../lib/auth/types";
import {
  acceptInvitation,
  fetchOrgUsage,
  listMyOrgs,
  listPendingInvitations,
  type OrgUsage,
} from "../../lib/org/client";
import {
  canManageOrg,
  type Org,
  type PendingInvitation,
} from "../../lib/org/types";
import { listProjects, listRooms } from "../../lib/project/client";
import { canManageProject, type Project } from "../../lib/project/types";
import { NotSignedIn } from "../../lib/session/client";
import type { Session } from "../../lib/session/types";
import {
  ChevronIcon,
  CloseIcon,
  GitBranchIcon,
  PlusIcon,
  ShieldIcon,
  SparkleIcon,
  SpinnerIcon,
  UserPlusIcon,
  UsersIcon,
} from "../icons";
import { PrimaryButton } from "../ui/Modal";
import {
  CreateOrgDialog,
  CreateProjectDialog,
  InviteDialog,
  OrgAdminDialog,
  ProjectMembersDialog,
  RoomSettingsDialog,
} from "./dialogs";
import { initials } from "./parts";

type Dialog =
  | { kind: "createOrg" }
  | { kind: "invite"; org: Org }
  | { kind: "orgAdmin"; org: Org }
  | { kind: "createProject"; org: Org }
  | { kind: "projectMembers"; org: Org; project: Project }
  | { kind: "roomSettings"; org: Org; project: Project; room: Session }
  | null;

export function OrgWorkspace() {
  const router = useRouter();
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);

  const reloadOrgs = useCallback(async () => {
    const list = await listMyOrgs();
    setOrgs(list);
    setActiveSlug((current) => current ?? list[0]?.slug ?? null);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await reloadOrgs();
        if (cancelled) return;
        setMe((await fetchMe()).user);
        setInvitations(await listPendingInvitations());
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof NotSignedIn) router.replace("/login");
        else setOrgs([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadOrgs, router]);

  const activeOrg = orgs?.find((o) => o.slug === activeSlug) ?? null;

  async function onAcceptInvite(id: string) {
    const slug = await acceptInvitation(id);
    setInvitations((current) => current.filter((i) => i.id !== id));
    await reloadOrgs();
    setActiveSlug(slug);
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-vs-editor text-vs-fg">
      <OrgRail
        orgs={orgs}
        me={me}
        activeSlug={activeSlug}
        onSelect={setActiveSlug}
        onCreate={() => setDialog({ kind: "createOrg" })}
        onSignOut={async () => {
          await logout();
          router.replace("/login");
        }}
      />

      {activeOrg ? (
        <OrgPanel
          key={activeOrg.slug}
          org={activeOrg}
          invitations={invitations.filter((i) => i.orgSlug === activeOrg.slug)}
          onAcceptInvite={onAcceptInvite}
          onInvite={() => setDialog({ kind: "invite", org: activeOrg })}
          onOpenAdmin={() => setDialog({ kind: "orgAdmin", org: activeOrg })}
          onNewProject={() => setDialog({ kind: "createProject", org: activeOrg })}
          onManageMembers={(project) =>
            setDialog({ kind: "projectMembers", org: activeOrg, project })
          }
          onRoomSettings={(project, room) =>
            setDialog({ kind: "roomSettings", org: activeOrg, project, room })
          }
          onOpenRoom={(id) => router.push(`/s/${id}`)}
        />
      ) : (
        <EmptyState loading={orgs === null} onCreate={() => setDialog({ kind: "createOrg" })} />
      )}

      {dialog?.kind === "createOrg" && (
        <CreateOrgDialog
          onClose={() => setDialog(null)}
          onCreated={async (org) => {
            setDialog(null);
            await reloadOrgs();
            setActiveSlug(org.slug);
          }}
        />
      )}
      {dialog?.kind === "invite" && (
        <InviteDialog org={dialog.org} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "orgAdmin" && (
        <OrgAdminDialog
          org={dialog.org}
          me={me}
          onClose={() => setDialog(null)}
          onManageProject={(project) =>
            setDialog({ kind: "projectMembers", org: dialog.org, project })
          }
        />
      )}
      {dialog?.kind === "createProject" && (
        <CreateProjectDialog
          org={dialog.org}
          onClose={() => setDialog(null)}
          onCreated={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "projectMembers" && (
        <ProjectMembersDialog
          org={dialog.org}
          project={dialog.project}
          me={me}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "roomSettings" && (
        <RoomSettingsDialog
          org={dialog.org}
          project={dialog.project}
          room={dialog.room}
          me={me}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Far-left rail: one icon per org, Discord style
// ---------------------------------------------------------------------------

function OrgRail({
  orgs,
  me,
  activeSlug,
  onSelect,
  onCreate,
  onSignOut,
}: {
  orgs: Org[] | null;
  me: CurrentUser | null;
  activeSlug: string | null;
  onSelect: (slug: string) => void;
  onCreate: () => void;
  onSignOut: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  // Close the profile menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!profileRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <nav
      aria-label="Organisations"
      className="flex w-[68px] shrink-0 flex-col items-center gap-2 border-r border-vs-border bg-vs-chrome py-3"
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-vs-accent/12 text-vs-accent">
        <SparkleIcon className="h-5 w-5" />
      </div>
      <div className="my-1 h-px w-8 bg-vs-border" />

      <div className="vs-scroll flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto">
        {(orgs ?? []).map((org) => {
          const active = org.slug === activeSlug;
          return (
            <button
              key={org.slug}
              type="button"
              onClick={() => onSelect(org.slug)}
              title={org.name}
              className={`relative flex h-11 w-11 items-center justify-center rounded-2xl text-[14px] font-semibold uppercase transition ${
                active
                  ? "rounded-xl bg-vs-accent text-vs-accent-fg"
                  : "bg-vs-panel text-vs-fg hover:rounded-xl hover:bg-vs-hover"
              }`}
            >
              {active && (
                <span className="absolute -left-3 h-6 w-1 rounded-r bg-vs-accent" />
              )}
              {initials(org.name)}
            </button>
          );
        })}

        <button
          type="button"
          onClick={onCreate}
          title="Create an organisation"
          className="flex h-11 w-11 items-center justify-center rounded-2xl bg-vs-panel text-vs-accent transition hover:rounded-xl hover:bg-vs-hover"
        >
          <PlusIcon className="h-5 w-5" />
        </button>
      </div>

      <div ref={profileRef} className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          title={me ? me.displayName : "Profile"}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-vs-accent/12 text-[12px] font-semibold uppercase text-vs-accent transition hover:opacity-80"
        >
          {me ? initials(me.displayName) : "?"}
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute bottom-0 left-full z-50 ml-2 w-60 overflow-hidden rounded-lg border border-vs-border bg-vs-panel shadow-lg"
          >
            <div className="flex items-center gap-2.5 border-b border-vs-border px-3 py-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-vs-accent/12 text-[12px] font-semibold uppercase text-vs-accent">
                {me ? initials(me.displayName) : "?"}
              </div>
              <div className="min-w-0">
                <p className="truncate text-[14px] font-medium text-vs-fg">
                  {me?.displayName ?? "Signed out"}
                </p>
                {me && (
                  <p className="truncate text-[12px] text-vs-muted">@{me.handle}</p>
                )}
              </div>
            </div>
            {me?.email && (
              <div className="px-3 py-2">
                <p className="text-[11px] uppercase tracking-wider text-vs-muted">Email</p>
                <p className="truncate text-[13px] text-vs-fg">{me.email}</p>
              </div>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onSignOut();
              }}
              className="flex w-full items-center gap-2 border-t border-vs-border px-3 py-2.5 text-left text-[14px] text-vs-fg transition hover:bg-vs-hover hover:text-vs-danger"
            >
              <CloseIcon className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Org content column: projects → rooms
// ---------------------------------------------------------------------------

function OrgPanel({
  org,
  invitations,
  onAcceptInvite,
  onInvite,
  onOpenAdmin,
  onNewProject,
  onManageMembers,
  onRoomSettings,
  onOpenRoom,
}: {
  org: Org;
  invitations: PendingInvitation[];
  onAcceptInvite: (id: string) => void;
  onInvite: () => void;
  onOpenAdmin: () => void;
  onNewProject: () => void;
  onManageMembers: (project: Project) => void;
  onRoomSettings: (project: Project, room: Session) => void;
  onOpenRoom: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loadedSlug, setLoadedSlug] = useState(org.slug);

  // Reset to the loading state the instant the org changes — during render, not
  // in the effect, so switching orgs never flashes the previous org's projects
  // (and without a synchronous setState inside the effect body).
  if (loadedSlug !== org.slug) {
    setLoadedSlug(org.slug);
    setProjects(null);
  }

  useEffect(() => {
    let cancelled = false;
    void listProjects(org.slug)
      .then((list) => !cancelled && setProjects(list))
      .catch(() => !cancelled && setProjects([]));
    return () => {
      cancelled = true;
    };
  }, [org.slug]);

  return (
    <div className="flex min-w-0 flex-1">
      <aside className="flex w-80 shrink-0 flex-col border-r border-vs-border bg-vs-panel">
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-vs-border px-4">
          <span className="min-w-0 truncate text-[14px] font-semibold">{org.name}</span>
          {canManageOrg(org.myRole) && (
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={onOpenAdmin}
                title="Organisation admin"
                className="rounded-md p-1.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
              >
                <ShieldIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={onInvite}
                title="Invite people"
                className="rounded-md p-1.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
              >
                <UserPlusIcon className="h-4 w-4" />
              </button>
            </div>
          )}
        </header>

        <UsageBadge orgSlug={org.slug} />

        {invitations.length > 0 && (
          <div className="border-b border-vs-border p-2">
            {invitations.map((invite) => (
              <div
                key={invite.id}
                className="rounded-lg border border-vs-accent/40 bg-vs-accent/10 p-2 text-sm"
              >
                <p className="leading-5">
                  {invite.invitedByName} invited you as {invite.role}.
                </p>
                <button
                  type="button"
                  onClick={() => onAcceptInvite(invite.id)}
                  className="mt-1.5 rounded bg-vs-accent px-2 py-1 text-[12px] font-medium text-vs-accent-fg"
                >
                  Accept
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <h2 className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
            Projects
          </h2>
          {canManageOrg(org.myRole) && (
            <button
              type="button"
              onClick={onNewProject}
              title="New project"
              className="rounded p-0.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="vs-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {projects === null ? (
            <p className="flex items-center gap-2 px-2 py-2 text-sm text-vs-muted">
              <SpinnerIcon className="h-3.5 w-3.5" /> Loading…
            </p>
          ) : projects.length === 0 ? (
            <p className="px-2 py-2 text-sm leading-5 text-vs-muted">
              No projects yet.{" "}
              {canManageOrg(org.myRole)
                ? "Connect a GitHub repo to get started."
                : "Ask an admin to add you to one."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  org={org}
                  project={project}
                  onManageMembers={() => onManageMembers(project)}
                  onRoomSettings={(room) => onRoomSettings(project, room)}
                  onOpenRoom={onOpenRoom}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>

      <main className="grid min-w-0 flex-1 place-items-center p-8">
        <div className="max-w-md text-center">
          <h1 className="font-display text-2xl font-semibold tracking-tight">{org.name}</h1>
          <p className="mt-2.5 text-[16px] leading-7 text-vs-muted">
            Everyone on a project has a room of their own — open yours to run AI sessions on the
            project&apos;s repo, or drop into a teammate&apos;s to see what they are working on.
          </p>
        </div>
      </main>
    </div>
  );
}

function ProjectRow({
  org,
  project,
  onManageMembers,
  onRoomSettings,
  onOpenRoom,
}: {
  org: Org;
  project: Project;
  onManageMembers: () => void;
  onRoomSettings: (room: Session) => void;
  onOpenRoom: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [rooms, setRooms] = useState<Session[] | null>(null);

  useEffect(() => {
    if (!open || rooms !== null) return;
    let cancelled = false;
    void listRooms(org.slug, project.slug)
      .then((list) => !cancelled && setRooms(list))
      .catch(() => !cancelled && setRooms([]));
    return () => {
      cancelled = true;
    };
  }, [open, rooms, org.slug, project.slug]);

  return (
    <li>
      <div className="group flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-vs-hover">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronIcon
            className={`h-3.5 w-3.5 shrink-0 text-vs-muted transition ${open ? "rotate-90" : ""}`}
          />
          {project.source === "github" && (
            <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />
          )}
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{project.name}</span>
        </button>
        <button
          type="button"
          onClick={onManageMembers}
          title={
            canManageProject(project.myRole)
              ? "View members & manage roles"
              : "View project members"
          }
          className="flex shrink-0 items-center gap-1 rounded-md border border-vs-border px-1.5 py-0.5 text-[11px] font-medium text-vs-muted transition hover:bg-vs-active hover:text-vs-fg"
        >
          <UsersIcon className="h-3 w-3" />
          Members
        </button>
      </div>

      {open && (
        <ul className="ml-4 border-l border-vs-border pl-2">
          {rooms === null ? (
            <li className="px-2 py-1 text-[12px] text-vs-muted">Loading…</li>
          ) : rooms.length === 0 ? (
            <li className="px-2 py-1 text-[12px] text-vs-muted">
              No rooms yet — yours is created when this list loads.
            </li>
          ) : (
            rooms.map((room) => (
              <li
                key={room.id}
                className="group/room flex items-center gap-1 rounded-md pr-1 hover:bg-vs-hover"
              >
                <button
                  type="button"
                  onClick={() => onOpenRoom(room.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[14px]"
                >
                  {room.visibility === "private" ? (
                    <ShieldIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />
                  ) : (
                    <span className="w-3.5 shrink-0 text-center text-vs-muted">#</span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{room.name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => onRoomSettings(room)}
                  title="Room privacy & members"
                  className="rounded p-0.5 text-vs-muted opacity-0 transition hover:bg-vs-active hover:text-vs-fg group-hover/room:opacity-100"
                >
                  <UsersIcon className="h-3.5 w-3.5" />
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </li>
  );
}

function EmptyState({ loading, onCreate }: { loading: boolean; onCreate: () => void }) {
  return (
    <div className="grid flex-1 place-items-center p-8">
      {loading ? (
        <SpinnerIcon className="h-5 w-5 text-vs-muted" />
      ) : (
        <div className="max-w-sm text-center">
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Create your first organisation
          </h1>
          <p className="mt-2.5 text-[16px] leading-7 text-vs-muted">
            An organisation is like a Discord server — invite your team, connect repos as projects,
            and open rooms to work in.
          </p>
          <div className="mt-4 flex justify-center">
            <PrimaryButton onClick={onCreate}>
              <PlusIcon className="h-4 w-4" /> New organisation
            </PrimaryButton>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The org's pooled AI-run usage — the visible side of resource pooling. Refreshes
 * on a light interval so "N running now" stays roughly live.
 */
function UsageBadge({ orgSlug }: { orgSlug: string }) {
  const [usage, setUsage] = useState<OrgUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => void fetchOrgUsage(orgSlug).then((u) => !cancelled && setUsage(u));
    load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [orgSlug]);

  if (!usage) return null;
  const atCap = usage.concurrency.used >= usage.concurrency.limit && usage.concurrency.limit > 0;

  return (
    <div className="flex items-center gap-3 border-b border-vs-border px-4 py-1.5 text-[12px] text-vs-muted">
      <span className="flex items-center gap-1.5" title="Agent runs active across the org right now">
        <span className={`h-1.5 w-1.5 rounded-full ${atCap ? "bg-vs-warn" : "bg-vs-success"}`} />
        {usage.concurrency.used}/{usage.concurrency.limit} running
      </span>
      {usage.monthly.limit != null && (
        <span title="Agent runs used this month">
          {usage.monthly.used}/{usage.monthly.limit} this month
        </span>
      )}
    </div>
  );
}
