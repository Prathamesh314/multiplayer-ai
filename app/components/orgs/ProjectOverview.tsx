"use client";

import { useState } from "react";
import type { CurrentUser } from "../../lib/auth/types";
import { canManageOrg, type Org } from "../../lib/org/types";
import { listRooms } from "../../lib/project/client";
import type { Project } from "../../lib/project/types";
import { ChevronIcon, GitBranchIcon, PlusIcon, SparkleIcon, SpinnerIcon, UsersIcon } from "../icons";
import { ErrorNote, GhostButton, PrimaryButton, inputClass } from "../ui/Modal";
import { TaskPanel } from "../tasks/TaskPanel";

type Props = {
  onConnectAi: () => void;
  onConnectComputer: () => void;
  org: Org;
  me: CurrentUser | null;
  projects: Project[] | null;
  error: string | null;
  onRetry: () => void;
  onNewProject: () => void;
  onInvite: () => void;
  onManageMembers: (project: Project) => void;
  onOpenRoom: (id: string) => void;
};

export function ProjectOverview({ org, me, projects, error, onRetry, onNewProject, onInvite, onManageMembers, onOpenRoom, onConnectAi, onConnectComputer }: Props) {
  const [search, setSearch] = useState("");
  const visible = projects?.filter((project) =>
    project.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <main className="vs-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
        <header className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-vs-muted">Team workspace</p>
            <h1 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{org.name}</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-vs-muted">
              Open a project to continue your work, or start something new with your team.
            </p>
          </div>
          {canManageOrg(org.myRole) && (
            <div className="flex flex-wrap gap-2">
              <GhostButton onClick={onInvite}><UsersIcon className="h-4 w-4" /> Invite team</GhostButton>
              <PrimaryButton onClick={onNewProject}><PlusIcon className="h-4 w-4" /> New project</PrimaryButton>
            </div>
          )}
        </header>

        {me && <TaskPanel key={me.id} userId={me.id} />}

        <section className="workspace-welcome mt-8 rounded-2xl border border-vs-border p-6 sm:p-8" aria-labelledby="workflow-heading">
          <div className="flex items-center gap-2 text-sm font-medium text-vs-muted">
            <SparkleIcon className="h-4 w-4 text-vs-accent" /> From your first prompt to a team result
          </div>
          <h2 id="workflow-heading" className="font-display mt-3 text-2xl font-semibold tracking-tight">Start with AI. Pick it up together.</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-vs-muted">A project organizes your team and repositories. A room is where you work on a task, keep its AI conversations, and invite teammates to continue it.</p>
          <details open={projects?.length === 0} className="mt-4">
            <summary className="cursor-pointer rounded-lg py-2 text-sm font-medium text-vs-fg">How this workspace works</summary>
          <ol className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
            {[
              ["Bring your code", "Open a project’s room and import a folder. Files and chats share one tabbed workspace."],
              ["Give AI a task", "Connect your AI, describe what you need, and review its changes before publishing."],
              ["Continue together", "Invite a teammate. Hand off a chat so they can continue with its conversation context."],
            ].map(([title, body], index) => (
              <li key={title} className="flex gap-3 rounded-xl border border-vs-border bg-vs-editor/60 p-4">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-vs-border bg-vs-editor text-xs text-vs-muted">{index + 1}</span>
                <div><p className="font-medium">{title}</p><p className="mt-1 leading-6 text-vs-muted">{body}</p></div>
              </li>
            ))}
          </ol>
          </details>
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-vs-border pt-5">
            <span className="mr-auto text-sm text-vs-muted">New here? Set up once, then choose a project below.</span>
            <GhostButton onClick={onConnectComputer}>Connect your computer</GhostButton>
            <GhostButton onClick={onConnectAi}><SparkleIcon className="h-4 w-4" /> Set up AI</GhostButton>
          </div>
        </section>

        <section className="mt-10" aria-labelledby="projects-heading" aria-busy={projects === null && !error}>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <h2 id="projects-heading" className="font-display flex items-center gap-3 text-xl font-semibold tracking-tight">
              Your projects
              {projects && <span className="rounded-md border border-vs-border px-2 py-0.5 font-sans text-xs font-medium text-vs-muted">{projects.length}</span>}
            </h2>
            <label className="w-full sm:w-64">
              <span className="sr-only">Search projects</span>
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a project…" className={inputClass} />
            </label>
          </div>
          {error ? (
            <div className="space-y-3"><ErrorNote>{error}</ErrorNote><GhostButton onClick={onRetry}>Try again</GhostButton></div>
          ) : projects === null ? (
            <p role="status" className="flex items-center gap-2 py-10 text-sm text-vs-muted"><SpinnerIcon className="h-4 w-4" /> Loading your projects…</p>
          ) : projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-vs-border p-8 text-center">
              <GitBranchIcon className="mx-auto h-7 w-7 text-vs-muted" />
              <h3 className="mt-4 text-lg font-semibold">Great work starts with a project</h3>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-vs-muted">
                {canManageOrg(org.myRole) ? "Create a project, then import code into a room. Your team can review and publish changes together." : "Ask an organisation admin to add you to a project so you can get started."}
              </p>
              {canManageOrg(org.myRole) && <div className="mt-5 flex justify-center"><PrimaryButton onClick={onNewProject}><PlusIcon className="h-4 w-4" /> Create your first project</PrimaryButton></div>}
            </div>
          ) : visible?.length === 0 ? (
            <div role="status" className="rounded-xl border border-vs-border p-8 text-center text-sm text-vs-muted">
              No projects match “{search}”.
              <button type="button" onClick={() => setSearch("")} className="ml-2 text-vs-fg underline underline-offset-4">Clear search</button>
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {visible?.map((project) => <ProjectCard key={project.id} project={project} org={org} me={me} onManageMembers={() => onManageMembers(project)} onOpenRoom={onOpenRoom} />)}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function ProjectCard({ project, org, me, onManageMembers, onOpenRoom }: Pick<Props, "org" | "me" | "onOpenRoom"> & { project: Project; onManageMembers: () => void }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openRoom() {
    if (opening || !me) return;
    setOpening(true);
    setError(null);
    try {
      const rooms = await listRooms(org.slug, project.slug);
      const room = project.myRole === "viewer" ? rooms[0] : rooms.find((candidate) => candidate.ownerId === me.id);
      if (!room) throw new Error(project.myRole === "viewer" ? "No rooms are available to view yet. Ask a project manager for access." : "Your room isn't ready yet. Try again, or ask a project manager for help.");
      onOpenRoom(room.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open your room.");
    } finally {
      setOpening(false);
    }
  }

  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-vs-border bg-vs-panel p-5 transition-colors hover:border-vs-muted/50">
      <div className="flex items-start gap-3">
        <span className="rounded-xl border border-vs-border bg-vs-editor p-3"><GitBranchIcon className="h-5 w-5 text-vs-muted" /></span>
        <div className="min-w-0 flex-1"><h3 className="truncate text-base font-semibold" title={project.name}>{project.name}</h3><p className="mt-1 truncate text-xs text-vs-muted" >Multiple repositories, one team workspace</p></div>
        <span className="rounded-md border border-vs-border px-2 py-1 text-xs capitalize text-vs-muted">{project.myRole}</span>
      </div>
      <div className="mt-5 flex items-center gap-2 text-xs text-vs-muted"><GitBranchIcon className="h-3.5 w-3.5" /><span className="truncate">Repositories</span><span aria-hidden>·</span><span>Separate rooms, shared project</span></div>
      {error && <div className="mt-4"><ErrorNote>{error}</ErrorNote></div>}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-5">
        <button type="button" onClick={onManageMembers} className="flex items-center gap-2 rounded-md py-2 text-sm text-vs-muted hover:text-vs-fg"><UsersIcon className="h-4 w-4" /> Members</button>
        <PrimaryButton disabled={opening || !me} onClick={() => void openRoom()}>{opening ? <SpinnerIcon className="h-4 w-4" /> : <ChevronIcon className="h-4 w-4" />}{opening ? "Opening…" : project.myRole === "viewer" ? "View a room" : "Open my room"}</PrimaryButton>
      </div>
    </article>
  );
}
