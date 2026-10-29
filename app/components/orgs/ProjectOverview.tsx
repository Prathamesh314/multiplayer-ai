"use client";

import { useCallback, useState } from "react";
import type { CurrentUser } from "../../lib/auth/types";
import { canManageOrg, type Org } from "../../lib/org/types";
import { addProjectMember, listRooms } from "../../lib/project/client";
import type { Project } from "../../lib/project/types";
import { ChevronIcon, GitBranchIcon, PlusIcon, SpinnerIcon, UsersIcon } from "../icons";
import { ErrorNote, GhostButton, PrimaryButton, inputClass } from "../ui/Modal";
import { type useHandoffInbox } from "../collaboration/HandoffInbox";
import { ActionQueue } from "./ActionQueue";
import { ComputerConnectionNotice } from "../ai/ComputerConnectionNotice";
import { OrgOnlineNow } from "../presence/OrgOnlineNow";
import type { ComputerConnection } from "../ai/useComputerConnection";
import { GettingStarted, HowItFits, useOnboarding } from "./GettingStarted";

type Props = {
  computerConnection: ComputerConnection;
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
  onConnections: (project: Project) => void;
  onOpenRoom: (id: string) => void;
  /** Handoffs waiting for you and sent by you (one live source with the sidebar's count). */
  handoffs: ReturnType<typeof useHandoffInbox>;
  /** Changes when a dialog closes, so the guide sees an invitation or member just added. */
  guideRevision?: number;
};

/** Your room in a project (joining it first as an org admin who was never added); throws what to tell you. */
async function myRoomIn(org: Org, project: Project, me: CurrentUser): Promise<string> {
  // Org owners and admins can see a project they were never added to; joining gives them a room in it.
  if (project.isMember === false && project.myRole === "manager") await addProjectMember(org.slug, project.slug, me.id, "manager");
  const rooms = await listRooms(org.slug, project.slug);
  const room = project.myRole === "viewer" ? rooms[0] : rooms.find((candidate) => candidate.ownerId === me.id);
  if (!room) throw new Error(project.myRole === "viewer" ? "No rooms are available to view yet. Ask a project manager for access." : "Your room isn't ready yet. Try again, or ask a project manager for help.");
  return room.id;
}

export function ProjectOverview({ computerConnection, org, me, projects, error, onRetry, onNewProject, onInvite, onManageMembers, onConnections, onOpenRoom, onConnectAi, onConnectComputer, handoffs, guideRevision = 0 }: Props) {
  const [search, setSearch] = useState("");
  const progress = useOnboarding(org.slug, `${projects?.length ?? -1}:${guideRevision}`);
  // Whether the guide is showing, and whether it holds the computer connection as a step to come.
  const [guideShown, setGuideShown] = useState(false);
  const [guideConnects, setGuideConnects] = useState(false);
  const onGuideVisible = useCallback((visible: boolean) => setGuideShown(visible), []);
  const onGuideConnects = useCallback((covers: boolean) => setGuideConnects(covers), []);
  const visible = projects?.filter((project) =>
    project.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <main className="app-page vs-scroll min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 lg:px-12 lg:py-10">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-vs-muted">Team</p>
            <h1 className="font-display mt-2 text-xl font-semibold tracking-tight sm:text-2xl">{org.name}</h1>
            <p className="mt-2 max-w-xl text-xs leading-5 text-vs-muted">
              {guideShown ? "Follow the steps below to get your team working together." : "Open a project to continue your work, or start something new with your team."}
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            {/* Who in the team has the app open, like collaborators on a shared doc. */}
            <OrgOnlineNow slug={org.slug} orgId={org.id} onInvite={canManageOrg(org.myRole) ? onInvite : undefined} />
            {canManageOrg(org.myRole) && (
              <div className="flex flex-wrap gap-2">
                <GhostButton onClick={onInvite}><UsersIcon className="h-3.5 w-3.5" /> Invite to team</GhostButton>
                {/* While the guide shows the next step, it holds the one primary button. */}
                {guideShown ? <GhostButton onClick={onNewProject}><PlusIcon className="h-3.5 w-3.5" /> New project</GhostButton>
                  : <PrimaryButton onClick={onNewProject}><PlusIcon className="h-3.5 w-3.5" /> New project</PrimaryButton>}
              </div>
            )}
          </div>
        </header>

        {/* The guide has its own connection step; a failed check stays visible either way. */}
        {(!guideConnects || computerConnection.status === "error") && <ComputerConnectionNotice bar connection={computerConnection} onConnect={onConnectComputer} onSetUpAi={onConnectAi} />}

        {me && <GettingStarted org={org} userId={me.id} progress={progress} connection={computerConnection} projects={projects}
          onNewProject={onNewProject} onInvite={onInvite} onManageMembers={onManageMembers} onConnectComputer={onConnectComputer} onSetUpAi={onConnectAi}
          onOpenRoom={async (project) => onOpenRoom(await myRoomIn(org, project, me))} onVisible={onGuideVisible} onCoversConnection={onGuideConnects} />}

        {me && <ActionQueue key={me.id} userId={me.id} handoffs={handoffs} />}

        <section className="mt-8" aria-labelledby="projects-heading" aria-busy={projects === null && !error}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 id="projects-heading" className="font-display flex items-center gap-2 text-sm font-semibold tracking-tight">
              Your projects
              {projects && <span className="rounded-md border border-vs-border px-1.5 py-0.5 font-sans text-[11px] font-medium text-vs-muted">{projects.length}</span>}
            </h2>
            <label className="w-full sm:w-64">
              <span className="sr-only">Search projects</span>
              <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a project…" className={inputClass} />
            </label>
          </div>
          {error ? (
            <div className="space-y-3"><ErrorNote>{error}</ErrorNote><GhostButton onClick={onRetry}>Try again</GhostButton></div>
          ) : projects === null ? (
            <p role="status" className="flex items-center gap-2 py-8 text-xs text-vs-muted"><SpinnerIcon className="h-3.5 w-3.5" /> Loading your projects…</p>
          ) : projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-vs-border p-6 text-center">
              <GitBranchIcon className="mx-auto h-6 w-6 text-vs-muted" />
              <h3 className="mt-3 text-sm font-semibold">Great work starts with a project</h3>
              <p className="mx-auto mt-1.5 max-w-md text-xs leading-5 text-vs-muted">
                {canManageOrg(org.myRole) ? "A project holds your team’s code and rooms. Create one, then add a repository or start a conversation in your room." : "Ask a team admin to add you to a project. It appears here as soon as they do."}
              </p>
              {canManageOrg(org.myRole) && !guideShown && <div className="mt-4 flex justify-center"><PrimaryButton onClick={onNewProject}><PlusIcon className="h-3.5 w-3.5" /> Create your first project</PrimaryButton></div>}
            </div>
          ) : visible?.length === 0 ? (
            <div role="status" className="rounded-xl border border-vs-border p-6 text-center text-xs text-vs-muted">
              No projects match “{search}”.
              <button type="button" onClick={() => setSearch("")} className="ml-2 text-vs-fg underline underline-offset-4">Clear search</button>
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {visible?.map((project) => <ProjectCard key={project.id} project={project} org={org} me={me} onManageMembers={() => onManageMembers(project)} onConnections={()=>onConnections(project)} onOpenRoom={onOpenRoom} />)}
            </div>
          )}
        </section>

        <HowItFits open={projects?.length === 0 && !guideShown} />

      </div>
    </main>
  );
}

function ProjectCard({ project, org, me, onManageMembers, onConnections, onOpenRoom }: Pick<Props, "org" | "me" | "onOpenRoom"> & { project: Project; onManageMembers: () => void; onConnections:()=>void }) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const joining = project.isMember === false && project.myRole === "manager";
  async function openRoom() {
    if (opening || !me) return;
    setOpening(true);
    setError(null);
    try {
      onOpenRoom(await myRoomIn(org, project, me));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open your room.");
    } finally {
      setOpening(false);
    }
  }

  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-vs-border bg-vs-panel p-4 transition-colors hover:border-vs-accent/50 sm:p-5">
      <div className="flex items-start gap-2.5">
        <span className="rounded-xl border border-vs-border bg-vs-editor p-2.5"><GitBranchIcon className="h-4 w-4 text-vs-muted" /></span>
        <div className="min-w-0 flex-1"><h3 className="break-words text-sm font-semibold" title={project.name}>{project.name}</h3><p className="mt-0.5 text-xs leading-5 text-vs-muted">Multiple repositories, one team workspace</p></div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-vs-muted"><span className="rounded-md border border-vs-border px-1.5 py-0.5 capitalize">{project.myRole}</span><span aria-hidden>·</span><span>Separate rooms, shared project</span></div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2.5 pt-4">
        <button type="button" onClick={onManageMembers} className="flex items-center gap-1.5 rounded-md py-1.5 text-xs text-vs-muted hover:text-vs-fg"><UsersIcon className="h-3.5 w-3.5" /> Members</button>
        <button type="button" onClick={onConnections} className="rounded-md py-1.5 text-xs text-vs-muted hover:text-vs-fg">Connections</button>
        <PrimaryButton disabled={opening || !me} onClick={() => void openRoom()}>{opening ? <SpinnerIcon className="h-3.5 w-3.5" /> : <ChevronIcon className="h-3.5 w-3.5" />}{opening ? (joining ? "Joining…" : "Opening…") : joining ? "Join this project" : project.myRole === "viewer" ? "View a room" : "Open my room"}</PrimaryButton>
      </div>
    </article>
  );
}
