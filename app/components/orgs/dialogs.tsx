"use client";

/*
 * The org workspace's modal dialogs, split out of OrgWorkspace.tsx: each is a
 * self-contained unit driven entirely by its props, so they live together here
 * and keep the workspace shell focused on layout and navigation.
 */

import { useCallback, useEffect, useState } from "react";
import type { CurrentUser } from "../../lib/auth/types";
import {
  acceptInvitation,
  acceptInvitationToken,
  createOrg,
  fetchOrgMembers,
  fetchOrgUsage,
  inviteByConnectCode,
  inviteByEmail,
  listPendingInvitations,
  type OrgUsage,
  removeOrgMember,
  updateOrgMember,
} from "../../lib/org/client";
import type { Org, OrgMember, OrgRole, PendingInvitation } from "../../lib/org/types";
import {
  addProjectMember,
  changeProjectMemberRole,
  createProject,
  fetchProjectMembers,
  listProjects,
  removeProjectMember,
} from "../../lib/project/client";
import {
  canManageProject,
  type Project,
  type ProjectMember,
  type ProjectRole,
} from "../../lib/project/types";
import {
  addRoomMember,
  fetchMembers,
  loadSession,
  removeRoomMember,
  renameSession,
  setRoomVisibility,
} from "../../lib/session/client";
import type { Session, SessionMember } from "../../lib/session/types";
import { CloseIcon, PlusIcon, ShieldIcon, SpinnerIcon, UsersIcon } from "../icons";
import { ErrorNote, Field, GhostButton, Modal, PrimaryButton, inputClass } from "../ui/Modal";
import { Avatar, CopyLink } from "./parts";
import { ComposerPicker } from "../workspace/ComposerPicker";

/**
 * The other half of getting started: joining an organisation someone else
 * runs. Three ways in, all of which already exist server-side — accept a
 * pending connect-code invitation, paste an email invite link, or share your
 * connect code so an admin can add you. This dialog just makes them reachable
 * from the start screen instead of only from inside an org you're already in.
 */
export function JoinOrgDialog({
  connectCode,
  onClose,
  onJoined,
}: {
  /** The caller's own code (from /api/auth/me), shown so they can share it. */
  connectCode: string | null;
  onClose: () => void;
  /** Called with the joined org's slug so the workspace can open it. */
  onJoined: (orgSlug: string) => void;
}) {
  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(null);
  const [link, setLink] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listPendingInvitations().then((list) => {
      if (!cancelled) setInvitations(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function accept(id: string) {
    setBusyId(id);
    setError(null);
    try {
      onJoined(await acceptInvitation(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not accept that invitation.");
      setBusyId(null);
    }
  }

  async function joinByLink() {
    // Accepts the pasted form people actually have: the full /invite/<token>
    // URL from the email, or the bare token.
    const token = link.trim().split("/invite/").pop()?.replace(/[/?#].*$/, "").trim() ?? "";
    if (!token) return;
    setBusyId("link");
    setError(null);
    try {
      onJoined(await acceptInvitationToken(token));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That invitation link is not valid.");
      setBusyId(null);
    }
  }

  return (
    <Modal
      title="Join an organisation"
      description="Accept an invitation, or share your connect code with an admin."
      onClose={onClose}
      footer={<GhostButton onClick={onClose}>Close</GhostButton>}
    >
      {error && <ErrorNote>{error}</ErrorNote>}

      <div>
        <p className="text-[11px] uppercase tracking-wider text-vs-muted">Invitations for you</p>
        {invitations === null ? (
          <div className="flex justify-center py-4">
            <SpinnerIcon className="h-4 w-4 text-vs-muted" />
          </div>
        ) : invitations.length === 0 ? (
          <p className="mt-1.5 text-[13px] text-vs-muted">
            Nothing yet — ask a teammate to invite you.
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {invitations.map((invite) => (
              <li
                key={invite.id}
                className="flex items-center gap-2.5 rounded-lg border border-vs-border px-3 py-2"
              >
                <Avatar name={invite.orgName} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium text-vs-fg">{invite.orgName}</p>
                  <p className="truncate text-[12px] text-vs-muted">
                    {invite.invitedByName} invited you as {invite.role}
                  </p>
                </div>
                <PrimaryButton onClick={() => accept(invite.id)} disabled={busyId !== null}>
                  {busyId === invite.id ? <SpinnerIcon className="h-4 w-4" /> : null} Accept
                </PrimaryButton>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Field label="Invite link" hint="Paste the link from an invitation email.">
        <div className="flex gap-2">
          <input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://…/invite/…"
            className={inputClass}
          />
          <div className="mt-1.5">
            <GhostButton onClick={joinByLink} disabled={busyId !== null || !link.trim()}>
              {busyId === "link" ? <SpinnerIcon className="h-4 w-4" /> : null} Join
            </GhostButton>
          </div>
        </div>
      </Field>

      {connectCode && (
        <Field
          label="Your connect code"
          hint="Share it with an org admin — they can add you directly."
        >
          <div className="mt-1.5 flex items-center gap-2">
            <code className="flex-1 rounded-md border border-vs-border bg-vs-editor px-3 py-2 font-mono text-[13px] text-vs-fg">
              {connectCode}
            </code>
            <GhostButton
              onClick={() => {
                void navigator.clipboard.writeText(connectCode).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : "Copy"}
            </GhostButton>
          </div>
        </Field>
      )}
    </Modal>
  );
}

export function CreateOrgDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (org: Org) => void }) {
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

export function CreateProjectDialog({
  org,
  onClose,
  onCreated,
}: {
  org: Org;
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createProject(org.slug, { name: name.trim() }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the project.");
      setBusy(false);
    }
  }

  return (
    <Modal title="New project"
      description="Organize your team, rooms, and repositories. Start empty, then add as many repositories as your work needs."
      onClose={onClose}
      footer={<><GhostButton onClick={onClose}>Cancel</GhostButton><PrimaryButton onClick={submit} disabled={busy || !name.trim()}>{busy && <SpinnerIcon className="h-4 w-4" />} Create</PrimaryButton></>}
    >
      {error && <ErrorNote>{error}</ErrorNote>}
      <Field label="Name">
        <input autoFocus className={inputClass} value={name} maxLength={80} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void submit(); }} placeholder="Customer platform" />
      </Field>
    </Modal>
  );
}

export function InviteDialog({ org, onClose }: { org: Org; onClose: () => void }) {
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
            className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition ${
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
              className={`flex-1 rounded-lg border px-3 py-1.5 text-sm font-medium capitalize transition ${
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
        <div className="rounded-lg border border-vs-border bg-vs-editor p-3 text-sm">
          {result.startsWith("http") ? (
            <>
              <p className="mb-1.5 text-vs-muted">Share this one-time link:</p>
              <CopyLink url={result} />
            </>
          ) : (
            <p className="text-vs-success">{result}</p>
          )}
        </div>
      )}
    </Modal>
  );
}

const ORG_ROLES: OrgRole[] = ["owner", "admin", "member"];

/**
 * The org admin dashboard: manage the roster (roles, suspension, removal), and
 * see projects and pooled usage in one place. Opened from the org header by
 * owners and admins. Mutations mirror the server's guardrails — you can't act on
 * yourself, and only an owner can touch (or mint) another owner.
 */
export function OrgAdminDialog({
  org,
  me,
  onClose,
  onManageProject,
}: {
  org: Org;
  me: CurrentUser | null;
  onClose: () => void;
  onManageProject: (project: Project) => void;
}) {
  const callerIsOwner = org.myRole === "owner";
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [usage, setUsage] = useState<OrgUsage | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setMembers(await fetchOrgMembers(org.slug));
  }, [org.slug]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchOrgMembers(org.slug),
      listProjects(org.slug),
      fetchOrgUsage(org.slug),
    ])
      .then(([m, p, u]) => {
        if (cancelled) return;
        setMembers(m);
        setProjects(p);
        setUsage(u);
      })
      .catch(() => {
        if (cancelled) return;
        setMembers([]);
        setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, [org.slug]);

  // Run a mutation for one member, then refresh — surfacing the server's message
  // (e.g. the last-owner guard) rather than swallowing it.
  async function mutate(userId: string, fn: () => Promise<void>) {
    setPending(userId);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong.");
    } finally {
      setPending(null);
    }
  }

  const roleOptions: OrgRole[] = callerIsOwner ? ORG_ROLES : ["admin", "member"];

  return (
    <Modal
      title={`${org.name} · admin`}
      description="Manage who's in the organisation and what they can do."
      onClose={onClose}
      width="max-w-2xl"
      footer={<GhostButton onClick={onClose}>Done</GhostButton>}
    >
      {error && <ErrorNote>{error}</ErrorNote>}

      {/* Pooled usage overview */}
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-vs-border px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-vs-muted">Running now</p>
          <p className="mt-0.5 text-[15px] font-semibold">
            {usage ? usage.concurrency.used : "—"}
          </p>
          {usage?.concurrency.limit != null && (
            <p className="mt-0.5 text-[11px] text-vs-muted" title="Applies only to AI turns running on the app's server, not on members' computers">
              Up to {usage.concurrency.limit} at once on the server
            </p>
          )}
        </div>
        <div className="rounded-lg border border-vs-border px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-vs-muted">AI turns this month</p>
          <p className="mt-0.5 text-[15px] font-semibold">
            {usage
              ? usage.monthly.limit != null
                ? `${usage.monthly.used} / ${usage.monthly.limit}`
                : usage.monthly.used
              : "—"}
          </p>
        </div>
      </div>

      {/* Roster */}
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
          Members ({members?.length ?? 0})
        </h3>
        {members === null ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-vs-muted">
            <SpinnerIcon className="h-3.5 w-3.5" /> Loading…
          </p>
        ) : (
          <ul className="mt-2 space-y-1">
            {members.map((m) => {
              const isSelf = m.userId === me?.id;
              const targetIsOwner = m.role === "owner";
              // Admins manage members and admins, never owners; nobody edits
              // themselves here. The server enforces the same rules.
              const editable = !isSelf && (callerIsOwner || !targetIsOwner);
              const suspended = m.status === "suspended";
              const busy = pending === m.userId;
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
                      {suspended && (
                        <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] uppercase tracking-wide text-amber-500">
                          Suspended
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[11px] text-vs-muted">@{m.handle}</span>
                  </span>

                  {editable ? (
                    <>
                      <ComposerPicker
                        variant="field"
                        value={m.role}
                        onChange={(value) =>
                          mutate(m.userId, () =>
                            updateOrgMember(org.slug, m.userId, { role: value as OrgRole }),
                          )
                        }
                        disabled={busy}
                        label={`Role for ${m.displayName}`}
                        className="shrink-0"
                        options={roleOptions.map(role => ({ id: role, label: role[0].toUpperCase() + role.slice(1) }))}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          mutate(m.userId, () =>
                            updateOrgMember(org.slug, m.userId, {
                              status: suspended ? "active" : "suspended",
                            }),
                          )
                        }
                        disabled={busy}
                        title={suspended ? "Reactivate" : "Suspend"}
                        className="rounded border border-vs-border px-1.5 py-1 text-[10px] uppercase tracking-wide text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-50"
                      >
                        {suspended ? "Reactivate" : "Suspend"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          mutate(m.userId, () => removeOrgMember(org.slug, m.userId))
                        }
                        disabled={busy}
                        title="Remove from organisation"
                        className="rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-red-500 disabled:opacity-50"
                      >
                        {busy ? (
                          <SpinnerIcon className="h-3.5 w-3.5" />
                        ) : (
                          <CloseIcon className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </>
                  ) : (
                    <span className="rounded bg-vs-active px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-vs-muted">
                      {m.role}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Projects — hands off to the per-project members dialog */}
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-vs-muted">
          Projects ({projects?.length ?? 0})
        </h3>
        {projects === null ? (
          <p className="mt-2 flex items-center gap-2 text-xs text-vs-muted">
            <SpinnerIcon className="h-3.5 w-3.5" /> Loading…
          </p>
        ) : projects.length === 0 ? (
          <p className="mt-2 text-xs leading-5 text-vs-muted">No projects yet.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {projects.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-2 rounded-lg border border-vs-border px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[13px]">{p.name}</span>
                <button
                  type="button"
                  onClick={() => onManageProject(p)}
                  className="flex items-center gap-1 rounded border border-vs-border px-2 py-1 text-[11px] transition hover:bg-vs-hover"
                >
                  <UsersIcon className="h-3.5 w-3.5" />
                  Members
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

const PROJECT_ROLES: ProjectRole[] = ["manager", "editor", "viewer"];

export function ProjectMembersDialog({
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

  // The fetch, with no state writes — so it can be driven both by the initial
  // effect (guarded against a stale apply) and by manual refresh after a change.
  const load = useCallback(
    () =>
      // Only project admins can list the org roster (to add people); everyone
      // else just needs the project members.
      Promise.all([
        fetchProjectMembers(org.slug, project.slug),
        canManage ? fetchOrgMembers(org.slug) : Promise.resolve([]),
      ]),
    [org.slug, project.slug, canManage],
  );

  const reload = useCallback(async () => {
    const [pm, om] = await load();
    setMembers(pm);
    setOrgMembers(om);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void load().then(([pm, om]) => {
      if (cancelled) return;
      setMembers(pm);
      setOrgMembers(om);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

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
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
          On this project ({members?.length ?? 0})
        </h3>
        {members === null ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-vs-muted">
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
                    <span className="block truncate text-[14px]">
                      {m.displayName}
                      {isSelf && <span className="text-vs-muted"> (you)</span>}
                    </span>
                    <span className="block truncate text-[12px] text-vs-muted">@{m.handle}</span>
                  </span>
                  {editable ? (
                    <ComposerPicker
                      variant="field"
                      value={m.role}
                      onChange={(value) => void changeRole(m.userId, value as ProjectRole)}
                      disabled={pending === m.userId}
                      label={`Role for ${m.displayName}`}
                      className="shrink-0"
                      options={PROJECT_ROLES.map(role => ({ id: role, label: role[0].toUpperCase() + role.slice(1) }))}
                    />
                  ) : (
                    <span className="rounded bg-vs-active px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-vs-muted">
                      {m.role}
                    </span>
                  )}
                  {editable && (
                    <button
                      type="button"
                      onClick={() => remove(m.userId)}
                      disabled={pending === m.userId}
                      title="Remove from project"
                      className="rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-danger disabled:opacity-50"
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
              Add from organisation
            </h3>
            <label className="flex items-center gap-1.5 text-[12px] text-vs-muted">
              Role
              <ComposerPicker
                label="Role for new project members"
                variant="field"
                value={role}
                onChange={(value) => setRole(value as ProjectRole)}
                disabled={pending !== null}
                options={PROJECT_ROLES.map(role => ({ id: role, label: role[0].toUpperCase() + role.slice(1) }))}
              />
            </label>
          </div>

          {addable.length === 0 ? (
            <p className="mt-2 text-sm leading-5 text-vs-muted">
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
                    <span className="block truncate text-[14px]">{m.displayName}</span>
                    <span className="block truncate text-[12px] text-vs-muted">@{m.handle}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => add(m.userId)}
                    disabled={pending === m.userId}
                    className="flex items-center gap-1 rounded border border-vs-border px-2 py-1 text-[12px] transition hover:bg-vs-hover disabled:opacity-50"
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

export function RoomSettingsDialog({
  org,
  project,
  room,
  me,
  onClose,
}: {
  org: Org;
  project: Project;
  room: Session;
  me: CurrentUser | null;
  onClose: () => void;
}) {
  const [visibility, setVisibilityState] = useState<"public" | "private">(room.visibility);
  const [name, setName] = useState(room.name);
  const [savedName, setSavedName] = useState(room.name);
  const [myRole, setMyRole] = useState<Session["myRole"]>(null);
  const [ownerId, setOwnerId] = useState(room.ownerId);
  const [members, setMembers] = useState<SessionMember[] | null>(null);
  const [projectMembers, setProjectMembers] = useState<ProjectMember[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The fetch, with no state writes — shared by the initial effect (guarded
  // against a stale apply) and by manual refresh after a change.
  const load = useCallback(
    () =>
      Promise.all([
        loadSession(room.id),
        fetchMembers(room.id),
        fetchProjectMembers(org.slug, project.slug),
      ]),
    [room.id, org.slug, project.slug],
  );

  const reload = useCallback(async () => {
    const [loaded, roster, pm] = await load();
    if (loaded.state === "ready") {
      setMyRole(loaded.session.myRole);
      setVisibilityState(loaded.session.visibility);
      setOwnerId(loaded.session.ownerId);
      setSavedName(loaded.session.name);
    }
    setMembers(roster);
    setProjectMembers(pm);
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    void load().then(([loaded, roster, pm]) => {
      if (cancelled) return;
      if (loaded.state === "ready") {
        setMyRole(loaded.session.myRole);
        setVisibilityState(loaded.session.visibility);
        setOwnerId(loaded.session.ownerId);
        setName(loaded.session.name);
        setSavedName(loaded.session.name);
      }
      setMembers(roster);
      setProjectMembers(pm);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // In a public project room the derived role can shadow ownership (an editor
  // whose own room this is still reads as editor), so check the owner directly.
  const isOwner = myRole === "owner" || (me !== null && ownerId === me.id);
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

  async function saveName() {
    const next = name.trim();
    if (!next || next === savedName) return;
    setError(null);
    try {
      const updated = await renameSession(room.id, next);
      setName(updated.name);
      setSavedName(updated.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename the room.");
      setName(savedName);
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
      title={`${savedName} · settings`}
      description="Public rooms are open to everyone on the project. Private rooms are invite-only."
      onClose={onClose}
      width="max-w-xl"
      footer={<GhostButton onClick={onClose}>Done</GhostButton>}
    >
      {error && <ErrorNote>{error}</ErrorNote>}

      <Field label="Name" hint="Your room starts out named after you — rename it to anything.">
        <input
          className={inputClass}
          value={name}
          disabled={!isOwner}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === "Enter" && saveName()}
        />
      </Field>

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
            <span className="flex items-center gap-1.5 text-[14px] font-medium">
              {option.v === "private" ? (
                <ShieldIcon className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <span className="w-3.5 shrink-0 text-center">#</span>
              )}
              {option.title}
            </span>
            <span className="mt-0.5 block text-[12px] leading-4 text-vs-muted">{option.hint}</span>
          </button>
        ))}
      </div>
      {!isOwner && (
        <p className="text-[12px] text-vs-muted">
          Only the room owner can rename it, change its privacy or manage who&apos;s in it.
        </p>
      )}

      <div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
          In this room ({members?.length ?? 0})
        </h3>
        {members === null ? (
          <p className="mt-2 flex items-center gap-2 text-sm text-vs-muted">
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
                  <span className="block truncate text-[14px]">{m.displayName}</span>
                  <span className="block truncate text-[12px] text-vs-muted">@{m.handle}</span>
                </span>
                <span className="rounded bg-vs-active px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-vs-muted">
                  {m.userId === ownerId ? "owner" : m.role}
                </span>
                {isOwner && m.userId !== ownerId && (
                  <button
                    type="button"
                    onClick={() => remove(m.userId)}
                    disabled={pending === m.userId}
                    title="Remove from room"
                    className="rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-danger disabled:opacity-50"
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
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
            Add from the project
          </h3>
          {addable.length === 0 ? (
            <p className="mt-2 text-sm leading-5 text-vs-muted">
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
                    <span className="block truncate text-[14px]">{m.displayName}</span>
                    <span className="block truncate text-[12px] text-vs-muted">@{m.handle}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => add(m.userId)}
                    disabled={pending === m.userId}
                    className="flex items-center gap-1 rounded border border-vs-border px-2 py-1 text-[12px] transition hover:bg-vs-hover disabled:opacity-50"
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
