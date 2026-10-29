"use client";
import { useHandoffInbox } from "../collaboration/HandoffInbox";
import { OrgSwitcher } from "./OrgSwitcher";
import { openUserStream } from "../../lib/events/shared-client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../ui/Toast";
import { fetchMe, logout } from "../../lib/auth/client";
import { loginHref, openSignIn } from "../../lib/auth/return-path";
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
import { pickOrg, rememberOrg } from "../../lib/org/last-org";
import type { Session } from "../../lib/session/types";
import {
  ChevronIcon,
  CloseIcon,
  GitBranchIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  SparkleIcon,
  LinkIcon,
  SpinnerIcon,
  TerminalIcon,
  UserPlusIcon,
  UsersIcon,
} from "../icons";
import { ErrorNote, GhostButton, Modal, PrimaryButton } from "../ui/Modal";
import { AgentToolsPanel } from "../ai/AgentToolsPanel";
import { ProjectOverview } from "./ProjectOverview";
import {
  CreateOrgDialog,
  CreateProjectDialog,
  InviteDialog,
  JoinOrgDialog,
  OrgAdminDialog,
  ProjectMembersDialog,
  RoomSettingsDialog,
} from "./dialogs";
import { OrgSettingsDialog } from "./OrgSettingsDialog";
import { initials } from "./parts";
import { ConnectionsPanel } from './ConnectionsPanel';
import { ConnectAiDialog } from "../ai/ConnectAiDialog";
import { DevicesDialog } from "../ai/DevicesDialog";
import { useComputerConnection, type ComputerConnection } from "../ai/useComputerConnection";
import { TaskPanel } from "../tasks/TaskPanel";
import chatStyles from "../chat/chat.module.css";

// Minimal settings gear icon
function GridIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}><rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4" /><rect x="9" y="2.5" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4" /><rect x="2.5" y="9" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4" /><rect x="9" y="9" width="4.5" height="4.5" rx="1.2" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

type Dialog =
  | { kind: "createOrg" }
  | { kind: "joinOrg" }
  | { kind: "connectAi" }
  | { kind: "devices" }
  | { kind: "agentTools" }
  | { kind: "invite"; org: Org }
  | { kind: "orgAdmin"; org: Org }
  | { kind: "orgSettings"; org: Org }
  | { kind: "createProject"; org: Org }
  | { kind: "projectMembers"; org: Org; project: Project }
  | { kind: "roomSettings"; org: Org; project: Project; room: Session }
  | null;

export function OrgWorkspace() {
  const router = useRouter();
  const { notify } = useToast();
  const computerConnection = useComputerConnection();
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [connectCode, setConnectCode] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [projectsRevision, setProjectsRevision] = useState(0);
  // Bumped as each dialog closes: the getting-started guide rereads its progress.
  const [guideRevision, setGuideRevision] = useState(0);
  const closeDialog = useCallback(() => { setDialog(null); setGuideRevision((current) => current + 1); }, []);

  const reloadOrgs = useCallback(async () => {
    const list = await listMyOrgs();
    setOrgs(list);
    const requestedOrg = new URLSearchParams(window.location.search).get('org');
    setActiveSlug((current) => pickOrg(list, requestedOrg, current));
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await reloadOrgs();
        if (cancelled) return;
        const who = await fetchMe();
        setMe(who.user);
        setConnectCode(who.connectCode);
        setInvitations(await listPendingInvitations().catch(() => []));

      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof NotSignedIn) openSignIn(loginHref(window.location.pathname + window.location.search));
        else setLoadError(cause instanceof Error ? cause.message : "Could not load your workspace.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadOrgs, router, loadVersion]);

  const activeOrg = orgs?.find((o) => o.slug === activeSlug) ?? null;

  // Keep the open org across a refresh: in the address (per tab, and shareable)
  // and in this browser (for a plain /workspace, or coming back from a room).
  useEffect(() => {
    if (!activeOrg) return;
    rememberOrg({ id: activeOrg.id, slug: activeOrg.slug });
    const url = new URL(window.location.href);
    if (url.searchParams.get("org") === activeOrg.slug) return;
    url.searchParams.set("org", activeOrg.slug);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [activeOrg]);

  async function onAcceptInvite(id: string): Promise<void> {
    const slug = await acceptInvitation(id);
    setInvitations((current) => current.filter((i) => i.id !== id));
    await reloadOrgs();
    setActiveSlug(slug);
  }

  const manage = activeOrg && canManageOrg(activeOrg.myRole) ? activeOrg : null;
  // A switch picked in the switcher rebuilds the view; its new switcher takes focus back.
  const refocusSwitcher = useRef(false);
  const takeSwitcherFocus = useCallback(() => { const take = refocusSwitcher.current; refocusSwitcher.current = false; return take; }, []);
  const switcher = (
    <OrgSwitcher
      orgs={orgs}
      activeSlug={activeSlug}
      onSelect={(slug, fromMenu) => { refocusSwitcher.current = !!fromMenu && slug !== activeSlug; setActiveSlug(slug); }}
      takeFocus={takeSwitcherFocus}
      onCreate={() => setDialog({ kind: "createOrg" })}
      onJoin={() => setDialog({ kind: "joinOrg" })}
      onSettings={manage ? () => setDialog({ kind: "orgSettings", org: manage }) : undefined}
      onAdmin={manage ? () => setDialog({ kind: "orgAdmin", org: manage }) : undefined}
      onInvite={manage ? () => setDialog({ kind: "invite", org: manage }) : undefined}
    />
  );
  const userMenu = (
    <UserMenu
      me={me}
      onOpenProviders={() => setDialog({ kind: "connectAi" })}
      onOpenDevices={() => setDialog({ kind: "devices" })}
      onOpenTools={() => setDialog({ kind: "agentTools" })}
      onSignOut={async () => {
        try { await logout(); openSignIn(); }
        catch { notify({ tone: "error", title: "Couldn’t sign out", description: "Please check your connection and try again." }); }
      }}
    />
  );
  const noOrgNav = () => (
    <p className="px-4 py-4 text-xs leading-5 text-vs-muted">{orgs === null ? "Loading your teams…" : "Create a team or join one to see its projects here."}</p>
  );

  return (
    <div className={`${chatStyles.workspace} flex h-dvh overflow-hidden bg-vs-editor text-vs-fg`}>
      {loadError ? (
        <WorkspaceShell title="Workspace" switcher={switcher} userMenu={userMenu} nav={noOrgNav}>
        <main className="grid min-w-0 flex-1 place-items-center p-6">
          <div className="max-w-md space-y-4">
            <h1 className="font-display text-2xl font-semibold">Could not load your workspace</h1>
            <ErrorNote>{loadError}</ErrorNote>
            <GhostButton onClick={() => { setLoadError(null); setLoadVersion((current) => current + 1); }}>Try again</GhostButton>
          </div>
        </main>
        </WorkspaceShell>
      ) : activeOrg ? (
        <OrgPanel
          switcher={switcher}
          userMenu={userMenu}
          computerConnection={computerConnection}
          onConnectAi={() => setDialog({ kind: "connectAi" })}
          onConnectComputer={() => setDialog({ kind: "devices" })}
          key={activeOrg.slug}
          org={activeOrg}
          refreshVersion={projectsRevision}
          guideRevision={guideRevision}
          me={me}
          invitations={invitations.filter((i) => i.orgSlug === activeOrg.slug)}
          onAcceptInvite={onAcceptInvite}
          onInvite={() => setDialog({ kind: "invite", org: activeOrg })}
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
        <WorkspaceShell title={orgs === null ? "Workspace" : "Get started"} switcher={switcher} userMenu={userMenu} nav={noOrgNav}>
        <div className="vs-scroll min-w-0 flex-1 overflow-y-auto p-5">
          {/* A team comes first; connecting a computer is a later step of its guide. */}
          <EmptyState
            loading={orgs === null}
            invitations={invitations}
            onAccept={onAcceptInvite}
            onCreate={() => setDialog({ kind: "createOrg" })}
            onJoin={() => setDialog({ kind: "joinOrg" })}
          />
          {/* Tasks assigned to you from chats shared with you; nothing is shown while there are none. */}
          {me && <div className="mx-auto w-full max-w-2xl"><TaskPanel key={me.id} userId={me.id} hideWhenEmpty /></div>}
        </div>
        </WorkspaceShell>
      )}

      {dialog?.kind === "createOrg" && (
        <CreateOrgDialog
          onClose={() => closeDialog()}
          onCreated={async (org) => {
            closeDialog();
            await reloadOrgs();
            setActiveSlug(org.slug);
          }}
        />
      )}
      {dialog?.kind === "connectAi" && <ConnectAiDialog onClose={() => closeDialog()} onOpenDevices={() => setDialog({ kind: "devices" })} />}
      {dialog?.kind === "agentTools" && (
        <Modal title="Your AI tools" description="MCP servers and plugins for the agents in your chats." width="max-w-3xl" onClose={() => closeDialog()}>
          <AgentToolsPanel scope="personal" base="/api/me/agent-tools" />
        </Modal>
      )}
      {dialog?.kind === "devices" && <DevicesDialog onClose={() => closeDialog()} onSetUpAi={() => setDialog({ kind: "connectAi" })} />}
      {dialog?.kind === "joinOrg" && (
        <JoinOrgDialog
          connectCode={connectCode}
          onClose={() => closeDialog()}
          onJoined={async (slug) => {
            closeDialog();
            await reloadOrgs();
            setActiveSlug(slug);
            setInvitations(await listPendingInvitations());
          }}
        />
      )}
      {dialog?.kind === "invite" && (
        <InviteDialog org={dialog.org} onClose={() => closeDialog()} />
      )}
      {dialog?.kind === "orgAdmin" && (
        <OrgAdminDialog
          org={dialog.org}
          me={me}
          onClose={() => closeDialog()}
          onManageProject={(project) =>
            setDialog({ kind: "projectMembers", org: dialog.org, project })
          }
        />
      )}
      {dialog?.kind === "orgSettings" && (
        <OrgSettingsDialog
          org={dialog.org}
          onClose={() => closeDialog()}
          onUpdated={async () => {
            closeDialog();
            await reloadOrgs();
          }}
        />
      )}
      {dialog?.kind === "createProject" && (
        <CreateProjectDialog
          org={dialog.org}
          onClose={() => closeDialog()}
          onCreated={() => {
            closeDialog();
            setProjectsRevision((current) => current + 1);
          }}
        />
      )}
      {dialog?.kind === "projectMembers" && (
        <ProjectMembersDialog
          org={dialog.org}
          project={dialog.project}
          me={me}
          onClose={() => closeDialog()}
        />
      )}
      {dialog?.kind === "roomSettings" && (
        <RoomSettingsDialog
          org={dialog.org}
          project={dialog.project}
          room={dialog.room}
          me={me}
          onClose={() => closeDialog()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sidebar: organisation switcher on top, navigation, signed-in person below
// ---------------------------------------------------------------------------

const menuItem = "flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-[13px] text-vs-fg transition hover:bg-vs-hover";

function UserMenu({
  me,
  onOpenProviders,
  onOpenDevices,
  onOpenTools,
  onSignOut,
}: {
  me: CurrentUser | null;
  onOpenProviders: () => void;
  onOpenDevices: () => void;
  onOpenTools: () => void;
  onSignOut: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!profileRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      // Handled here, so the phone drawer around it stays open.
      if (event.key === "Escape") { event.preventDefault(); setMenuOpen(false); }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const run = (action: () => void) => () => { setMenuOpen(false); action(); };
  return (
    <div ref={profileRef} className="relative" aria-label="Your account">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          title={me ? me.displayName : "Profile"}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl p-1.5 text-left transition hover:bg-vs-hover aria-expanded:bg-vs-hover"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-vs-active text-[11px] font-semibold uppercase text-vs-accent" aria-hidden="true">{me ? initials(me.displayName) : "?"}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-semibold leading-5 text-vs-fg">{me?.displayName ?? "Signed out"}</span>
            {me && <span className="block truncate text-[11px] leading-4 text-vs-muted">@{me.handle}</span>}
          </span>
        </button>
        <button type="button" className={chatStyles.iconButton} aria-label="AI providers" title="AI providers" onClick={onOpenProviders}><SparkleIcon /></button>
        <button type="button" className={chatStyles.iconButton} aria-label="Your computers" title="Your computers" onClick={onOpenDevices}><TerminalIcon /></button>
      </div>

      {menuOpen && (
        <div role="menu" className="absolute bottom-full left-0 z-50 mb-1.5 w-full min-w-[240px] overflow-hidden rounded-xl border border-vs-border bg-vs-panel p-1.5 shadow-[0_18px_48px_rgb(0_0_0_/_0.45)]">
          {me?.email && (
            <div className="px-2.5 pb-2 pt-1">
              <p className="truncate text-[13px] font-medium text-vs-fg">{me.displayName}</p>
              <p className="truncate text-[12px] text-vs-muted">{me.email}</p>
            </div>
          )}
          <div className="border-t border-vs-border pt-1">
            <button type="button" role="menuitem" onClick={run(onOpenProviders)} className={menuItem}><SparkleIcon className="h-4 w-4 text-vs-accent" />AI providers</button>
            <button type="button" role="menuitem" onClick={run(onOpenDevices)} className={menuItem}><TerminalIcon className="h-4 w-4 text-vs-muted" />Your computers</button>
            <button type="button" role="menuitem" onClick={run(onOpenTools)} className={menuItem}><LinkIcon className="h-4 w-4 text-vs-muted" />Your AI tools</button>
            <a href="/account" role="menuitem" className={menuItem}><ShieldIcon className="h-4 w-4 text-vs-muted" />Account settings</a>
          </div>
          <div className="mt-1 border-t border-vs-border pt-1">
            <button type="button" role="menuitem" onClick={run(onSignOut)} className={`${menuItem} hover:text-vs-danger`}><CloseIcon className="h-4 w-4" />Sign out</button>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}><path d="M2.75 4.25h10.5M2.75 8h10.5M2.75 11.75h10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}

/**
 * One sidebar for the workspace: the organisation switcher, navigation, and
 * the signed-in person. On phones it is a drawer opened from a slim top bar.
 */
function WorkspaceShell({
  title,
  switcher,
  userMenu,
  nav,
  children,
}: {
  title: string;
  switcher: React.ReactNode;
  userMenu: React.ReactNode;
  nav: (closeNavigation: () => void) => React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    // On window, after menus inside the drawer have had their own Escape.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-vs-border bg-vs-chrome px-2 lg:hidden">
        <button type="button" aria-label="Open navigation" aria-expanded={open} aria-controls="workspace-navigation" onClick={() => setOpen(true)}
          className="grid h-9 w-9 place-items-center rounded-lg text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg">
          <MenuIcon className="h-5 w-5" />
        </button>
        <span className="min-w-0 truncate text-sm font-semibold">{title}</span>
      </div>
      {open && <button type="button" aria-label="Close navigation" tabIndex={-1} onClick={close} className="fixed inset-0 z-30 bg-black/55 backdrop-blur-[1px] lg:hidden" />}
      <aside
        id="workspace-navigation"
        aria-label="Workspace navigation"
        className={`${chatStyles.workspaceNavigation} ${open ? "fixed inset-y-0 left-0 z-40 flex w-[min(300px,88vw)] shadow-[20px_0_60px_rgb(0_0_0_/_0.5)]" : "hidden"} flex-col border-r border-vs-border lg:static lg:z-auto lg:flex lg:w-[280px] lg:shadow-none`}
      >
        <div className="shrink-0 border-b border-vs-border p-2">{switcher}</div>
        <div className="vs-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">{nav(close)}</div>
        <div className="shrink-0 border-t border-vs-border p-2">{userMenu}</div>
      </aside>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org content column
// ---------------------------------------------------------------------------

function OrgPanel({
  switcher,
  userMenu,
  computerConnection,
  onConnectAi,
  onConnectComputer,
  org,
  refreshVersion,
  guideRevision,
  me,
  invitations,
  onAcceptInvite,
  onInvite,
  onNewProject,
  onManageMembers,
  onRoomSettings,
  onOpenRoom,
}: {
  switcher: React.ReactNode;
  userMenu: React.ReactNode;
  computerConnection: ComputerConnection;
  onConnectAi: () => void;
  onConnectComputer: () => void;
  org: Org;
  refreshVersion: number;
  guideRevision: number;
  me: CurrentUser | null;
  invitations: PendingInvitation[];
  onAcceptInvite: (id: string) => void;
  onInvite: () => void;
  onNewProject: () => void;
  onManageMembers: (project: Project) => void;
  onRoomSettings: (project: Project, room: Session) => void;
  onOpenRoom: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectVersion, setProjectVersion] = useState(0);
  const [roomSearch, setRoomSearch] = useState("");
  const [loadedSlug, setLoadedSlug] = useState(org.slug);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [connectionProject, setConnectionProject] = useState<string | null>(null);
  const handoffs = useHandoffInbox();
  const waitingHandoffs = handoffs.data?.received.length ?? 0;
  // Back from signing in with Discord: open its server list once.
  const [chooseDiscord, setChooseDiscord] = useState(false);

  if (loadedSlug !== org.slug) {
    setLoadedSlug(org.slug);
    setProjects(null);
  }

  useEffect(() => {
    let cancelled = false;
    void listProjects(org.slug)
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        setProjectError(null);
        const requested = new URLSearchParams(window.location.search).get('connections');
        if (requested && list.some(project => project.id === requested)) {
          setConnectionProject(requested);setConnectionsOpen(true);
          setChooseDiscord(new URLSearchParams(window.location.search).get('discord') === 'choose');
          window.history.replaceState(null,'','/workspace');
        }
      })
      .catch((cause) => !cancelled && setProjectError(cause instanceof Error ? cause.message : "Could not load projects."));
    return () => {
      cancelled = true;
    };
  }, [org.slug, projectVersion, refreshVersion]);

  const navItem = (current: boolean) => `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition ${current ? "bg-vs-active text-vs-fg" : "text-vs-muted hover:bg-vs-hover hover:text-vs-fg"}`;
  const nav = (closeNavigation: () => void) => (
    <>
      <nav aria-label="Workspace sections" className="space-y-0.5 px-2 pt-2">
        <button type="button" onClick={() => { setConnectionsOpen(false); closeNavigation(); }} aria-current={!connectionsOpen ? "page" : undefined} className={navItem(!connectionsOpen)}>
          <GridIcon className="h-4 w-4 shrink-0" /> Project overview
          {waitingHandoffs > 0 && <span title={`${waitingHandoffs} handoff${waitingHandoffs === 1 ? "" : "s"} waiting for you`} className="ml-auto rounded-full bg-vs-accent px-1.5 text-[11px] font-semibold leading-[18px] text-vs-accent-fg">{waitingHandoffs}<span className="sr-only"> handoffs waiting</span></span>}
        </button>
        <button type="button" onClick={() => { setConnectionsOpen(true); closeNavigation(); }} aria-current={connectionsOpen ? "page" : undefined} className={navItem(connectionsOpen)}>
          <LinkIcon className="h-4 w-4 shrink-0" /> Connections <span className="ml-auto text-[11px] font-normal text-vs-muted">Slack · Discord · AI</span>
        </button>
        <Link href="/shared" className={navItem(false)}>
          <UsersIcon className="h-4 w-4 shrink-0" /> Shared with me
        </Link>
      </nav>
      <UsageBadge orgSlug={org.slug} />

      {invitations.length > 0 && (
        <div className="space-y-2 px-3 pt-2">
          {invitations.map((invite) => (
            <div key={invite.id} className="rounded-xl border border-vs-accent/40 bg-vs-accent/10 p-2.5 text-xs">
              <p className="leading-4">{invite.invitedByName} invited you as {invite.role}.</p>
              <button type="button" onClick={() => onAcceptInvite(invite.id)} className="mt-1.5 rounded-md bg-vs-accent px-2 py-1 text-[11px] font-medium text-vs-accent-fg">Accept</button>
            </div>
          ))}
        </div>
      )}

      <div className="pb-3">
        <div className="flex items-center justify-between px-4 pb-1 pt-4">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">Projects</h2>
          {canManageOrg(org.myRole) && (
            <button type="button" onClick={onNewProject} title="New project" aria-label="New project" className="rounded-md p-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg">
              <PlusIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="px-3 pb-2 pt-1">
          <div className="flex items-center gap-2 rounded-lg border border-vs-border bg-vs-editor px-2.5 focus-within:border-vs-accent">
            <SearchIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />
            <input
              type="search"
              aria-label="Search rooms"
              placeholder="Search rooms…"
              value={roomSearch}
              onChange={(event) => setRoomSearch(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setRoomSearch(""); }}
              className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-vs-fg outline-none placeholder:text-vs-muted [&::-webkit-search-cancel-button]:hidden"
            />
            {roomSearch && <button type="button" aria-label="Clear room search" onClick={() => setRoomSearch("")} className="rounded p-0.5 text-vs-muted hover:bg-vs-hover hover:text-vs-fg"><CloseIcon className="h-3.5 w-3.5" /></button>}
          </div>
        </div>

        <div className="px-2">
          {projectError ? (
            <p role="alert" className="px-2 py-2 text-xs text-vs-danger">Could not load projects. Retry from the project overview.</p>
          ) : projects === null ? (
            <p className="flex items-center gap-2 px-2 py-2 text-xs text-vs-muted">
              <SpinnerIcon className="h-3.5 w-3.5" /> Loading…
            </p>
          ) : projects.length === 0 ? (
            <p className="px-2 py-2 text-xs leading-4 text-vs-muted">
              No projects yet.{" "}
              {canManageOrg(org.myRole) ? "Create a project, then add your code in a room." : "Ask an admin to add you to one."}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {projects.map((project) => (
                <ProjectRow
                  key={project.id}
                  org={org}
                  project={project}
                  currentUserId={me?.id ?? null}
                  roomSearch={roomSearch}
                  onManageMembers={() => onManageMembers(project)}
                  onRoomSettings={(room) => onRoomSettings(project, room)}
                  onOpenRoom={onOpenRoom}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );

  return (
    <WorkspaceShell title={org.name} switcher={switcher} userMenu={userMenu} nav={nav}>
      {connectionsOpen ? (
        <ConnectionsPanel org={org} projects={projects??[]} selectedId={connectionProject} onSelect={setConnectionProject} chooseDiscord={chooseDiscord} onDiscordChosen={()=>setChooseDiscord(false)}/>
      ) : (
        <ProjectOverview
          computerConnection={computerConnection}
          onConnectAi={onConnectAi}
          onConnectComputer={onConnectComputer}
          org={org}
          me={me}
          projects={projects}
          error={projectError}
          onRetry={() => { setProjectError(null); setProjectVersion((current) => current + 1); }}
          onNewProject={onNewProject}
          onInvite={onInvite}
          onManageMembers={onManageMembers}
          onConnections={project=>{setConnectionProject(project.id);setConnectionsOpen(true);}}
          handoffs={handoffs}
          onOpenRoom={onOpenRoom}
          guideRevision={guideRevision}
        />
      )}
    </WorkspaceShell>
  );
}

function ProjectRow({
  org,
  project,
  currentUserId,
  roomSearch,
  onManageMembers,
  onRoomSettings,
  onOpenRoom,
}: {
  org: Org;
  project: Project;
  currentUserId: string | null;
  roomSearch: string;
  onManageMembers: () => void;
  onRoomSettings: (room: Session) => void;
  onOpenRoom: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [rooms, setRooms] = useState<Session[] | null>(null);
  const query = roomSearch.trim().toLowerCase();
  const expanded = open || query.length > 0;
  const visibleRooms = rooms
    ?.filter((room) => room.name.toLowerCase().includes(query))
    .sort((a, b) => currentUserId ? Number(b.ownerId === currentUserId) - Number(a.ownerId === currentUserId) : 0);

  useEffect(() => {
    if (!expanded || rooms !== null) return;
    let cancelled = false;
    void listRooms(org.slug, project.slug)
      .then((list) => !cancelled && setRooms(list))
      .catch(() => !cancelled && setRooms([]));
    return () => {
      cancelled = true;
    };
  }, [expanded, rooms, org.slug, project.slug]);

  return (
    <li>
      <div className="group flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-vs-hover">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={expanded}
          disabled={query.length > 0}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <ChevronIcon
            className={`h-3 w-3 shrink-0 text-vs-muted transition ${expanded ? "rotate-90" : ""}`}
          />
          <GitBranchIcon className="h-3 w-3 shrink-0 text-vs-muted" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{project.name}</span>
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
      </div>

      {expanded && (
        <ul className="ml-4 border-l border-vs-border pl-2">
          {rooms === null ? (
            <li className="px-2 py-1 text-[11px] text-vs-muted">Loading…</li>
          ) : rooms.length === 0 ? (
            <li className="px-2 py-1 text-[11px] text-vs-muted">
              No rooms yet — yours is created when this list loads.
            </li>
          ) : visibleRooms?.length === 0 ? (
            <li role="status" className="px-2 py-2 text-[11px] text-vs-muted">No rooms match your search.</li>
          ) : (
            visibleRooms?.map((room) => (
              <li
                key={room.id}
                className="group/room flex items-center gap-1 rounded-md pr-1 hover:bg-vs-hover"
              >
                <button
                  type="button"
                  onClick={() => onOpenRoom(room.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[12.5px]"
                >
                  {room.visibility === "private" ? (
                    <ShieldIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />
                  ) : (
                    <span className="w-3.5 shrink-0 text-center text-vs-muted">#</span>
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {room.ownerId === currentUserId ? "[Me] " : ""}{room.name}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onRoomSettings(room)}
                  title="Room privacy & members"
                  className="rounded p-0.5 text-vs-muted opacity-100 transition hover:bg-vs-active hover:text-vs-fg lg:opacity-0 lg:group-hover/room:opacity-100 lg:group-focus-within/room:opacity-100"
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

function EmptyState({
  loading,
  invitations,
  onAccept,
  onCreate,
  onJoin,
}: {
  loading: boolean;
  invitations: PendingInvitation[];
  onAccept: (id: string) => Promise<void>;
  onCreate: () => void;
  onJoin: () => void;
}) {
  const [accepting, setAccepting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function accept(id: string) {
    setAccepting(id);
    setError(null);
    try { await onAccept(id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn’t accept the invitation. Please try again."); setAccepting(null); }
  }
  return (
    <main className="grid min-w-0 place-items-center py-4 sm:py-10">
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-xs text-vs-muted"><SpinnerIcon className="h-4 w-4" /> Loading your teams…</p>
      ) : (
        <div className="workspace-welcome w-full max-w-2xl rounded-2xl border border-vs-border p-5 sm:p-9">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-vs-muted">Welcome to Multicode AI</p>
          <h1 className="font-display text-xl font-semibold tracking-tight sm:text-2xl">{invitations.length ? "You’ve been invited to a team" : "Start with your team"}</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-vs-muted">
            A team is your organization in Multicode: the people you work with and the projects you share. Inside a project, each of you gets a room where you and your AI agents work on the code, then review and publish it together.
          </p>
          {invitations.length > 0 && (
            <ul aria-label="Invitations" className="mt-5 space-y-2">
              {invitations.map((invite) => (
                <li key={invite.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-vs-accent/40 bg-vs-accent/10 p-3.5">
                  <p className="min-w-0 text-sm leading-5"><strong className="font-semibold">{invite.orgName}</strong><span className="block text-xs text-vs-muted">{invite.invitedByName} invited you as {invite.role === "admin" ? "an admin" : "a member"}.</span></p>
                  <PrimaryButton disabled={accepting !== null} onClick={() => void accept(invite.id)}>
                    {accepting === invite.id && <SpinnerIcon className="h-3.5 w-3.5" />} Join {invite.orgName}
                  </PrimaryButton>
                </li>
              ))}
            </ul>
          )}
          {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            {invitations.length ? (
              <GhostButton onClick={onCreate}><PlusIcon className="h-3.5 w-3.5" /> Create your own team</GhostButton>
            ) : (
              <>
                <PrimaryButton onClick={onCreate}><PlusIcon className="h-3.5 w-3.5" /> Create your team</PrimaryButton>
                <GhostButton onClick={onJoin}><UserPlusIcon className="h-3.5 w-3.5" /> Join an existing team</GhostButton>
              </>
            )}
          </div>
          <p className="mt-3 text-xs leading-5 text-vs-muted">
            {invitations.length ? "Joining puts you in the team. A team admin then adds you to the projects you work on." : "Creating a team makes you its owner: you then add a project, connect your computer and invite teammates, one step at a time. Joining needs an invite link or your connect code."}
          </p>
          <p className="mt-4 border-t border-vs-border pt-4 text-xs leading-5 text-vs-muted">
            Someone shared a single chat with you instead? <Link href="/shared" className="text-vs-accent underline underline-offset-4">Open chats shared with me</Link>
          </p>
        </div>
      )}
    </main>
  );
}

function UsageBadge({ orgSlug }: { orgSlug: string }) {
  const [usage, setUsage] = useState<OrgUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => void fetchOrgUsage(orgSlug).then((u) => !cancelled && setUsage(u));
    const stream = openUserStream(type => { if (type === "usage.changed") load(); }, load);
    return () => {
      cancelled = true;
      stream.close();
    };
  }, [orgSlug]);

  if (!usage) return null;

  return (
    <div className="flex items-center gap-3 border-b border-vs-border px-3 py-2 text-[11px] text-vs-muted">
      <span className="flex items-center gap-1.5" title="AI turns running across the organisation right now. Turns on members' own computers have no limit.">
        <span className="h-1.5 w-1.5 rounded-full bg-vs-success" />
        {usage.concurrency.used} running
      </span>
      {usage.monthly.limit != null && (
        <span title="Agent runs used this month">
          {usage.monthly.used}/{usage.monthly.limit} this month
        </span>
      )}
    </div>
  );
}
