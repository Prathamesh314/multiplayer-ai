"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchMe, logout } from "../../lib/auth/client";
import type { CurrentUser } from "../../lib/auth/types";
import {
  acceptInvitation,
  createOrg,
  fetchOrgMembers,
  fetchOrgUsage,
  inviteByConnectCode,
  inviteByEmail,
  listMyOrgs,
  listPendingInvitations,
  type OrgUsage,
} from "../../lib/org/client";
import {
  canManageOrg,
  type Org,
  type OrgMember,
  type PendingInvitation,
} from "../../lib/org/types";
import {
  addProjectMember,
  changeProjectMemberRole,
  createProject,
  createRoom,
  fetchProjectMembers,
  listProjects,
  listRooms,
  removeProjectMember,
} from "../../lib/project/client";
import {
  canManageProject,
  type Project,
  type ProjectMember,
  type ProjectRole,
} from "../../lib/project/types";
import {
  NotSignedIn,
  addRoomMember,
  fetchMembers,
  loadSession,
  removeRoomMember,
  setRoomVisibility,
} from "../../lib/session/client";
import type { Session, SessionMember } from "../../lib/session/types";
import {
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  FilesIcon,
  GitBranchIcon,
  PlusIcon,
  SparkleIcon,
  SpinnerIcon,
  UserPlusIcon,
  UsersIcon,
} from "../icons";
import {
  ErrorNote,
  Field,
  GhostButton,
  Modal,
  PrimaryButton,
  inputClass,
} from "../ui/Modal";

type Dialog =
  | { kind: "createOrg" }
  | { kind: "invite"; org: Org }
  | { kind: "createProject"; org: Org }
  | { kind: "createRoom"; org: Org; project: Project }
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
          onNewProject={() => setDialog({ kind: "createProject", org: activeOrg })}
          onNewRoom={(project) => setDialog({ kind: "createRoom", org: activeOrg, project })}
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
      {dialog?.kind === "createProject" && (
        <CreateProjectDialog
          org={dialog.org}
          onClose={() => setDialog(null)}
          onCreated={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "createRoom" && (
        <CreateRoomDialog
          org={dialog.org}
          project={dialog.project}
          onClose={() => setDialog(null)}
          onCreated={(id) => router.push(`/s/${id}`)}
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
              className={`relative flex h-11 w-11 items-center justify-center rounded-2xl text-[13px] font-semibold uppercase transition ${
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
          className="flex h-10 w-10 items-center justify-center rounded-full bg-vs-accent/12 text-[11px] font-semibold uppercase text-vs-accent transition hover:opacity-80"
        >
          {me ? initials(me.displayName) : "?"}
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute bottom-0 left-full z-50 ml-2 w-60 overflow-hidden rounded-lg border border-vs-border bg-vs-panel shadow-lg"
          >
            <div className="flex items-center gap-2.5 border-b border-vs-border px-3 py-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-vs-accent/12 text-[11px] font-semibold uppercase text-vs-accent">
                {me ? initials(me.displayName) : "?"}
              </div>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-vs-fg">
                  {me?.displayName ?? "Signed out"}
                </p>
                {me && (
                  <p className="truncate text-[11px] text-vs-muted">@{me.handle}</p>
                )}
              </div>
            </div>
            {me?.email && (
              <div className="px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-vs-muted">Email</p>
                <p className="truncate text-[12px] text-vs-fg">{me.email}</p>
              </div>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onSignOut();
              }}
              className="flex w-full items-center gap-2 border-t border-vs-border px-3 py-2.5 text-left text-[13px] text-vs-fg transition hover:bg-vs-hover hover:text-red-500"
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
  onNewProject,
  onNewRoom,
  onManageMembers,
  onRoomSettings,
  onOpenRoom,
}: {
  org: Org;
  invitations: PendingInvitation[];
  onAcceptInvite: (id: string) => void;
  onInvite: () => void;
  onNewProject: () => void;
  onNewRoom: (project: Project) => void;
  onManageMembers: (project: Project) => void;
  onRoomSettings: (project: Project, room: Session) => void;
  onOpenRoom: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProjects(null);
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
          <span className="min-w-0 truncate text-[13px] font-semibold">{org.name}</span>
          {canManageOrg(org.myRole) && (
            <button
              type="button"
              onClick={onInvite}
              title="Invite people"
              className="shrink-0 rounded-md p-1.5 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
            >
              <UserPlusIcon className="h-4 w-4" />
            </button>
          )}
        </header>

        <UsageBadge orgSlug={org.slug} />

        {invitations.length > 0 && (
          <div className="border-b border-vs-border p-2">
            {invitations.map((invite) => (
              <div
                key={invite.id}
                className="rounded-lg border border-vs-accent/40 bg-vs-accent/10 p-2 text-xs"
              >
                <p className="leading-5">
                  {invite.invitedByName} invited you as {invite.role}.
                </p>
                <button
                  type="button"
                  onClick={() => onAcceptInvite(invite.id)}
                  className="mt-1.5 rounded bg-vs-accent px-2 py-1 text-[11px] font-medium text-vs-accent-fg"
                >
                  Accept
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
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
            <p className="flex items-center gap-2 px-2 py-2 text-xs text-vs-muted">
              <SpinnerIcon className="h-3.5 w-3.5" /> Loading…
            </p>
          ) : projects.length === 0 ? (
            <p className="px-2 py-2 text-xs leading-5 text-vs-muted">
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
                  onNewRoom={() => onNewRoom(project)}
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
          <h1 className="text-lg font-semibold">{org.name}</h1>
          <p className="mt-2 text-sm leading-6 text-vs-muted">
            Pick a room from a project to open its files, chat and agent runs. Rooms are shared with
            everyone on the project.
          </p>
        </div>
      </main>
    </div>
  );
}

function ProjectRow({
  org,
  project,
  onNewRoom,
  onManageMembers,
  onRoomSettings,
  onOpenRoom,
}: {
  org: Org;
  project: Project;
  onNewRoom: () => void;
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
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{project.name}</span>
        </button>
        <button
          type="button"
          onClick={onManageMembers}
          title={
            canManageProject(project.myRole)
              ? "View members & manage roles"
              : "View project members"
          }
          className="flex shrink-0 items-center gap-1 rounded-md border border-vs-border px-1.5 py-0.5 text-[10px] font-medium text-vs-muted transition hover:bg-vs-active hover:text-vs-fg"
        >
          <UsersIcon className="h-3 w-3" />
          Members
        </button>
        {canManageProject(project.myRole) && (
          <button
            type="button"
            onClick={onNewRoom}
            title="New room"
            className="rounded p-0.5 text-vs-muted opacity-0 transition hover:bg-vs-active hover:text-vs-fg group-hover:opacity-100"
          >
            <PlusIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <ul className="ml-4 border-l border-vs-border pl-2">
          {rooms === null ? (
            <li className="px-2 py-1 text-[11px] text-vs-muted">Loading…</li>
          ) : rooms.length === 0 ? (
            <li className="px-2 py-1 text-[11px] text-vs-muted">No rooms yet.</li>
          ) : (
            rooms.map((room) => (
              <li
                key={room.id}
                className="group/room flex items-center gap-1 rounded-md pr-1 hover:bg-vs-hover"
              >
                <button
                  type="button"
                  onClick={() => onOpenRoom(room.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px]"
                >
                  <span className="text-vs-muted">{room.visibility === "private" ? "🔒" : "#"}</span>
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
          <h1 className="text-lg font-semibold">Create your first organisation</h1>
          <p className="mt-2 text-sm leading-6 text-vs-muted">
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

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function CreateOrgDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (org: Org) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      onCreated(await createOrg({ name }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New organisation"
      description="Invite your team and group your projects under it."
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <SpinnerIcon className="h-4 w-4" /> : null} Create
          </PrimaryButton>
        </>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <Field label="Name" hint="You can change this later.">
        <input
          autoFocus
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && submit()}
          placeholder="Acme Robotics"
        />
      </Field>
    </Modal>
  );
}

function CreateProjectDialog({
  org,
  onClose,
  onCreated,
}: {
  org: Org;
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [source, setSource] = useState<"github" | "local">("github");
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const project = await createProject(org.slug, {
        name: name.trim() || repo.split("/").pop() || "Project",
        source,
        githubRepo: source === "github" ? repo.trim() : undefined,
        defaultBranch: source === "github" ? branch.trim() || "main" : undefined,
        upstreamUrl: source === "github" ? `https://github.com/${repo.trim()}.git` : undefined,
      });
      onCreated(project);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      setBusy(false);
    }
  }

  const valid = source === "github" ? /^[^/\s]+\/[^/\s]+$/.test(repo.trim()) : name.trim().length > 0;

  return (
    <Modal
      title="New project"
      description="A project is a repo. Everyone you add to it can open all of its rooms."
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={busy || !valid}>
            {busy ? <SpinnerIcon className="h-4 w-4" /> : null} Create
          </PrimaryButton>
        </>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        {(["github", "local"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSource(option)}
            className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium capitalize transition ${
              source === option
                ? "border-vs-accent bg-vs-accent/10 text-vs-fg"
                : "border-vs-border text-vs-muted hover:bg-vs-hover"
            }`}
          >
            {option === "github" ? "Connect GitHub" : "Empty / local"}
          </button>
        ))}
      </div>

      {source === "github" ? (
        <>
          <Field label="Repository" hint="owner/name, as it appears on GitHub.">
            <input
              autoFocus
              className={inputClass}
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="acme/web"
            />
          </Field>
          <Field label="Default branch">
            <input className={inputClass} value={branch} onChange={(e) => setBranch(e.target.value)} />
          </Field>
        </>
      ) : (
        <Field label="Name">
          <input
            autoFocus
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Prototype"
          />
        </Field>
      )}
    </Modal>
  );
}

function CreateRoomDialog({
  org,
  project,
  onClose,
  onCreated,
}: {
  org: Org;
  project: Project;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const room = await createRoom(org.slug, project.slug, name.trim() || undefined, visibility);
      onCreated(room.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`New room in ${project.name}`}
      description="A room is one line of work on this project's repo."
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={submit} disabled={busy}>
            {busy ? <SpinnerIcon className="h-4 w-4" /> : null} Create
          </PrimaryButton>
        </>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <Field label="Name" hint="Optional — a name is generated if you leave it blank.">
        <input
          autoFocus
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Fix the parser"
        />
      </Field>

      <Field label="Visibility">
        <div className="mt-1.5 grid grid-cols-2 gap-2">
          {(
            [
              { v: "public", title: "Public", hint: "Anyone on the project can drop in." },
              { v: "private", title: "Private", hint: "Invite-only. You add who can see it." },
            ] as const
          ).map((option) => (
            <button
              key={option.v}
              type="button"
              onClick={() => setVisibility(option.v)}
              className={`rounded-lg border px-3 py-2 text-left transition ${
                visibility === option.v
                  ? "border-vs-accent bg-vs-accent/10"
                  : "border-vs-border hover:bg-vs-hover"
              }`}
            >
              <span className="block text-[13px] font-medium">
                {option.v === "private" ? "🔒 " : "# "}
                {option.title}
              </span>
              <span className="mt-0.5 block text-[11px] leading-4 text-vs-muted">{option.hint}</span>
            </button>
          ))}
        </div>
      </Field>
    </Modal>
  );
}

function InviteDialog({ org, onClose }: { org: Org; onClose: () => void }) {
  const [tab, setTab] = useState<"code" | "email">("email");
  const [value, setValue] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      if (tab === "email") {
        const { link } = await inviteByEmail(org.slug, value.trim(), role);
        setResult(link);
      } else {
        const invited = await inviteByConnectCode(org.slug, value.trim(), role);
        setResult(`Invitation sent to ${invited.displayName} (@${invited.handle}).`);
      }
      setValue("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Invite to ${org.name}`}
      description="Email a one-time link, or add someone by their connect code."
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose}>Done</GhostButton>
          <PrimaryButton onClick={submit} disabled={busy || !value.trim()}>
            {busy ? <SpinnerIcon className="h-4 w-4" /> : null}
            {tab === "email" ? "Create link" : "Invite"}
          </PrimaryButton>
        </>
      }
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex gap-2">
        {(["email", "code"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setTab(option);
              setResult(null);
            }}
            className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
              tab === option
                ? "border-vs-accent bg-vs-accent/10 text-vs-fg"
                : "border-vs-border text-vs-muted hover:bg-vs-hover"
            }`}
          >
            {option === "email" ? "Invite link" : "Connect code"}
          </button>
        ))}
      </div>

      <Field label={tab === "email" ? "Email address" : "Connect code"}>
        <input
          autoFocus
          className={inputClass}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={tab === "email" ? "teammate@example.com" : "PK-XXXX-XXXX"}
        />
      </Field>

      <Field label="Role">
        <div className="mt-1.5 flex gap-2">
          {(["member", "admin"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setRole(option)}
              className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition ${
                role === option
                  ? "border-vs-accent bg-vs-accent/10 text-vs-fg"
                  : "border-vs-border text-vs-muted hover:bg-vs-hover"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </Field>

      {result && (
        <div className="rounded-lg border border-vs-border bg-vs-editor p-3 text-xs">
          {result.startsWith("http") ? (
            <>
              <p className="mb-1.5 text-vs-muted">Share this one-time link:</p>
              <CopyLink url={result} />
            </>
          ) : (
            <p className="text-emerald-500">{result}</p>
          )}
        </div>
      )}
    </Modal>
  );
}

const PROJECT_ROLES: ProjectRole[] = ["manager", "editor", "viewer"];

function ProjectMembersDialog({
  org,
  project,
  me,
  onClose,
}: {
  org: Org;
  project: Project;
  me: CurrentUser | null;
  onClose: () => void;
}) {
  const canManage = canManageProject(project.myRole);
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [role, setRole] = useState<ProjectRole>("editor");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    // Only project admins can list the org roster (to add people); everyone
    // else just needs the project members.
    const [pm, om] = await Promise.all([
      fetchProjectMembers(org.slug, project.slug),
      canManage ? fetchOrgMembers(org.slug) : Promise.resolve([]),
    ]);
    setMembers(pm);
    setOrgMembers(om);
  }, [org.slug, project.slug, canManage]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Org members not already on the project — the people you can add.
  const onProject = new Set((members ?? []).map((m) => m.userId));
  const addable = orgMembers.filter((m) => !onProject.has(m.userId));

  async function add(userId: string) {
    setPending(userId);
    setError(null);
    try {
      await addProjectMember(org.slug, project.slug, userId, role);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add that member.");
    } finally {
      setPending(null);
    }
  }

  async function changeRole(userId: string, next: ProjectRole) {
    setPending(userId);
    setError(null);
    try {
      await changeProjectMemberRole(org.slug, project.slug, userId, next);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change that role.");
    } finally {
      setPending(null);
    }
  }

  async function remove(userId: string) {
    setPending(userId);
    setError(null);
    try {
      await removeProjectMember(org.slug, project.slug, userId);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove that member.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Modal
      title={`${project.name} · members`}
      description={
        canManage
          ? "Anyone here can open every room in this project. Change roles, add people from your organisation, or remove members."
          : "Everyone on this project can open its rooms. Only a project manager can change roles or membership."
      }
      onClose={onClose}
      width="max-w-xl"
      footer={<GhostButton onClick={onClose}>Done</GhostButton>}
    >
      {error && <ErrorNote>{error}</ErrorNote>}

      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
          On this project ({members?.length ?? 0})
        </h3>
        {members === null ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-vs-muted">
            <SpinnerIcon className="h-3.5 w-3.5" /> Loading…
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {members.map((m) => {
              const isSelf = m.userId === me?.id;
              // A manager can manage everyone but themselves, so a project can't
              // lock itself out by self-demotion or self-removal.
              const editable = canManage && !isSelf;
              return (
                <li
                  key={m.userId}
                  className="flex items-center gap-2 rounded-lg border border-vs-border px-2.5 py-1.5"
                >
                  <Avatar name={m.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">
                      {m.displayName}
                      {isSelf && <span className="text-vs-muted"> (you)</span>}
                    </span>
                    <span className="block truncate text-[11px] text-vs-muted">@{m.handle}</span>
                  </span>
                  {editable ? (
                    <select
                      value={m.role}
                      onChange={(e) => changeRole(m.userId, e.target.value as ProjectRole)}
                      disabled={pending === m.userId}
                      aria-label={`Role for ${m.displayName}`}
                      className="rounded border border-vs-border bg-vs-editor px-1.5 py-1 text-[11px] uppercase tracking-wide text-vs-fg outline-none disabled:opacity-50"
                    >
                      {PROJECT_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="rounded bg-vs-active px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted">
                      {m.role}
                    </span>
                  )}
                  {editable && (
                    <button
                      type="button"
                      onClick={() => remove(m.userId)}
                      disabled={pending === m.userId}
                      title="Remove from project"
                      className="rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-red-500 disabled:opacity-50"
                    >
                      {pending === m.userId ? (
                        <SpinnerIcon className="h-3.5 w-3.5" />
                      ) : (
                        <CloseIcon className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {canManage && (
        <div>
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
              Add from organisation
            </h3>
            <label className="flex items-center gap-1.5 text-[11px] text-vs-muted">
              Role
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as ProjectRole)}
                className="rounded border border-vs-border bg-vs-editor px-1.5 py-1 text-[11px] text-vs-fg outline-none"
              >
                {PROJECT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {addable.length === 0 ? (
            <p className="mt-2 text-xs leading-5 text-vs-muted">
              Everyone in {org.name} is already on this project. Invite more people to the org first.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {addable.map((m) => (
                <li
                  key={m.userId}
                  className="flex items-center gap-2 rounded-lg border border-vs-border px-2.5 py-1.5"
                >
                  <Avatar name={m.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{m.displayName}</span>
                    <span className="block truncate text-[11px] text-vs-muted">@{m.handle}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => add(m.userId)}
                    disabled={pending === m.userId}
                    className="flex items-center gap-1 rounded border border-vs-border px-2 py-1 text-[11px] transition hover:bg-vs-hover disabled:opacity-50"
                  >
                    {pending === m.userId ? (
                      <SpinnerIcon className="h-3.5 w-3.5" />
                    ) : (
                      <PlusIcon className="h-3.5 w-3.5" />
                    )}
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}

function RoomSettingsDialog({
  org,
  project,
  room,
  onClose,
}: {
  org: Org;
  project: Project;
  room: Session;
  onClose: () => void;
}) {
  const [visibility, setVisibilityState] = useState<"public" | "private">(room.visibility);
  const [myRole, setMyRole] = useState<Session["myRole"]>(null);
  const [ownerId, setOwnerId] = useState(room.ownerId);
  const [members, setMembers] = useState<SessionMember[] | null>(null);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [loaded, roster, pm] = await Promise.all([
      loadSession(room.id),
      fetchMembers(room.id),
      fetchProjectMembers(org.slug, project.slug),
    ]);
    if (loaded.state === "ready") {
      setMyRole(loaded.session.myRole);
      setVisibilityState(loaded.session.visibility);
      setOwnerId(loaded.session.ownerId);
    }
    setMembers(roster);
    setProjectMembers(pm);
  }, [room.id, org.slug, project.slug]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isOwner = myRole === "owner";
  const onRoster = new Set((members ?? []).map((m) => m.userId));
  const addable = projectMembers.filter((m) => !onRoster.has(m.userId));

  async function flip(next: "public" | "private") {
    setError(null);
    setVisibilityState(next); // optimistic
    try {
      await setRoomVisibility(room.id, next);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change visibility.");
      setVisibilityState((v) => (v === next ? room.visibility : v));
    }
  }

  async function add(userId: string) {
    setPending(userId);
    setError(null);
    try {
      await addRoomMember(room.id, userId, "editor");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add that person.");
    } finally {
      setPending(null);
    }
  }

  async function remove(userId: string) {
    setPending(userId);
    setError(null);
    try {
      await removeRoomMember(room.id, userId);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove that person.");
    } finally {
      setPending(null);
    }
  }

  return (
    <Modal
      title={`${room.name} · privacy`}
      description="Public rooms are open to everyone on the project. Private rooms are invite-only."
      onClose={onClose}
      width="max-w-xl"
      footer={<GhostButton onClick={onClose}>Done</GhostButton>}
    >
      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="grid grid-cols-2 gap-2">
        {(
          [
            { v: "public", title: "Public", hint: "Anyone on the project can drop in." },
            { v: "private", title: "Private", hint: "Only people you add can see it." },
          ] as const
        ).map((option) => (
          <button
            key={option.v}
            type="button"
            disabled={!isOwner}
            onClick={() => flip(option.v)}
            className={`rounded-lg border px-3 py-2 text-left transition disabled:opacity-60 ${
              visibility === option.v
                ? "border-vs-accent bg-vs-accent/10"
                : "border-vs-border hover:bg-vs-hover"
            }`}
          >
            <span className="block text-[13px] font-medium">
              {option.v === "private" ? "🔒 " : "# "}
              {option.title}
            </span>
            <span className="mt-0.5 block text-[11px] leading-4 text-vs-muted">{option.hint}</span>
          </button>
        ))}
      </div>
      {!isOwner && (
        <p className="text-[11px] text-vs-muted">
          Only the room owner can change its privacy or manage who&apos;s in it.
        </p>
      )}

      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
          In this room ({members?.length ?? 0})
        </h3>
        {members === null ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-vs-muted">
            <SpinnerIcon className="h-3.5 w-3.5" /> Loading…
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {members.map((m) => (
              <li
                key={m.userId}
                className="flex items-center gap-2 rounded-lg border border-vs-border px-2.5 py-1.5"
              >
                <Avatar name={m.displayName} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{m.displayName}</span>
                  <span className="block truncate text-[11px] text-vs-muted">@{m.handle}</span>
                </span>
                <span className="rounded bg-vs-active px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted">
                  {m.userId === ownerId ? "owner" : m.role}
                </span>
                {isOwner && m.userId !== ownerId && (
                  <button
                    type="button"
                    onClick={() => remove(m.userId)}
                    disabled={pending === m.userId}
                    title="Remove from room"
                    className="rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-red-500 disabled:opacity-50"
                  >
                    {pending === m.userId ? (
                      <SpinnerIcon className="h-3.5 w-3.5" />
                    ) : (
                      <CloseIcon className="h-3.5 w-3.5" />
                    )}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isOwner && visibility === "private" && (
        <div>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
            Add from the project
          </h3>
          {addable.length === 0 ? (
            <p className="mt-2 text-xs leading-5 text-vs-muted">
              Everyone on {project.name} is already in this room.
            </p>
          ) : (
            <ul className="mt-2 space-y-1">
              {addable.map((m) => (
                <li
                  key={m.userId}
                  className="flex items-center gap-2 rounded-lg border border-vs-border px-2.5 py-1.5"
                >
                  <Avatar name={m.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{m.displayName}</span>
                    <span className="block truncate text-[11px] text-vs-muted">@{m.handle}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => add(m.userId)}
                    disabled={pending === m.userId}
                    className="flex items-center gap-1 rounded border border-vs-border px-2 py-1 text-[11px] transition hover:bg-vs-hover disabled:opacity-50"
                  >
                    {pending === m.userId ? (
                      <SpinnerIcon className="h-3.5 w-3.5" />
                    ) : (
                      <PlusIcon className="h-3.5 w-3.5" />
                    )}
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
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
    <div className="flex items-center gap-3 border-b border-vs-border px-4 py-1.5 text-[11px] text-vs-muted">
      <span className="flex items-center gap-1.5" title="Agent runs active across the org right now">
        <span className={`h-1.5 w-1.5 rounded-full ${atCap ? "bg-amber-500" : "bg-emerald-500"}`} />
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

function Avatar({ name }: { name: string }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-vs-accent/12 text-[10px] font-semibold uppercase text-vs-accent">
      {initials(name)}
    </span>
  );
}

/**
 * A read-only link with a copy button. The field is selectable so a copy is
 * always possible by hand, and the button falls back to selecting the text if
 * the async clipboard API is unavailable (older browsers, insecure contexts).
 */
function CopyLink({ url }: { url: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      inputRef.current?.select();
      try {
        document.execCommand("copy");
      } catch {
        // Nothing else to try; the text is selected for a manual copy.
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        ref={inputRef}
        readOnly
        value={url}
        onFocus={(e) => e.target.select()}
        className="min-w-0 flex-1 rounded border border-vs-border bg-vs-panel px-2 py-1.5 font-mono text-[11px] text-vs-fg outline-none"
      />
      <button
        type="button"
        onClick={copy}
        className={`flex shrink-0 items-center gap-1 rounded border px-2 py-1.5 text-[11px] font-medium transition ${
          copied
            ? "border-emerald-500/50 text-emerald-500"
            : "border-vs-border text-vs-muted hover:bg-vs-hover hover:text-vs-fg"
        }`}
      >
        {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <FilesIcon className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
