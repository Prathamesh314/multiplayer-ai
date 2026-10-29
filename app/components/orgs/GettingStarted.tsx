"use client";

/*
 * The getting-started guide on a team's overview: from a new team to a first
 * task the team shares, one step at a time, each saying why it matters.
 *
 * Progress comes from the work itself (/api/orgs/[slug]/onboarding plus this
 * computer's connection), so it survives reloads and devices, and a team that
 * already works together never sees the guide. Hiding it early is remembered
 * in this browser only.
 */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fetchAgents } from "../../lib/ai/client";
import { fetchOrgOnboarding } from "../../lib/org/client";
import type { OrgOnboarding } from "../../lib/org/onboarding";
import { canManageOrg, type Org } from "../../lib/org/types";
import type { Project } from "../../lib/project/types";
import { CheckIcon, SpinnerIcon } from "../icons";
import { ErrorNote, PrimaryButton } from "../ui/Modal";
import type { ComputerConnection } from "../ai/useComputerConnection";

type Step = {
  id: string;
  title: string;
  why: string;
  done: boolean;
  /** Where things stand when it isn't done yet. */
  state?: string;
  action?: { label: string; run: () => void | Promise<void> };
};

const hiddenKey = (org: Org, userId: string) => `multicode.guide.hidden:${org.id}:${userId}`;

/** This team's progress, kept fresh when you come back to the tab. Null until (or unless) it loads. */
export function useOnboarding(slug: string, revision: string) {
  const [progress, setProgress] = useState<OrgOnboarding | null>(null);
  const load = useCallback(() => {
    if (document.hidden) return;
    void fetchOrgOnboarding(slug).then(setProgress).catch(() => {});
  }, [slug]);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [load, revision]);
  return progress;
}

/** Whether one of your computers can run an AI tool now (null while unknown). */
function useAiReady(connection: ComputerConnection) {
  const [ready, setReady] = useState<boolean | null>(null);
  const connected = connection.status === "connected";
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const check = () => void fetchAgents().then(response => { if (!cancelled) setReady(response.canRun && response.agents.some(agent => agent.installed)); }).catch(() => {});
    check();
    window.addEventListener("focus", check);
    return () => { cancelled = true; window.removeEventListener("focus", check); };
  }, [connected, connection.devices]);
  return connected ? ready : false;
}

export function guideSteps({ org, progress, connection, aiReady, firstProject, onNewProject, onInvite, onOpenRoom, onManageMembers, onConnectComputer, onSetUpAi }: {
  org: Org;
  progress: OrgOnboarding;
  connection: ComputerConnection;
  aiReady: boolean | null;
  firstProject: Project | null;
  onNewProject: () => void;
  onInvite: () => void;
  onOpenRoom: (project: Project) => Promise<void>;
  onManageMembers: (project: Project) => void;
  onConnectComputer: () => void;
  onSetUpAi: () => void;
}): Step[] {
  const manager = canManageOrg(org.myRole);
  const openRoom = firstProject ? { label: "Open my room", run: () => onOpenRoom(firstProject) } : undefined;
  const computerReady = connection.status === "connected" && aiReady === true;
  const steps: Step[] = [
    manager ? {
      id: "project",
      title: "Create a project",
      why: "A project holds your team’s code. Everyone on it gets a room of their own, with its own Git branch, so nobody’s experiment touches the project until it is published.",
      done: progress.projects > 0,
      action: { label: "Create a project", run: onNewProject },
    } : {
      id: "project",
      title: "Get added to a project",
      why: "A team admin adds you to a project. You then get your own room in it, where you and your AI agents work.",
      done: progress.projects > 0,
      state: "Ask a team admin to add you from the project’s Members. This page updates when they do.",
    },
    {
      id: "code",
      title: "Add your code",
      why: "Agents work on the code in your room. Add a repository or a folder from your computer, or start without files to plan or brainstorm.",
      done: progress.codeAdded || progress.myTasks > 0,
      action: openRoom,
    },
    {
      id: "computer",
      title: "Connect your computer and one AI tool",
      why: "AI tasks run on your computer, with your own Claude Code, Codex or Gemini sign-in. One signed-in tool is enough. Reading, reviewing and inviting work without it.",
      // Once you've finished a task it has been done; whether it's online now is the status bar's job.
      done: computerReady || progress.myTasks > 0,
      state: connection.status === "checking" ? "Checking your computer…"
        : connection.status === "error" ? "Couldn’t check your computer. Check your internet connection."
        : connection.status === "offline" ? `${connection.computer?.name ?? "Your computer"} is offline: closed, paused or asleep.`
        : connection.status === "update" ? `${connection.computer?.name ?? "Your computer"} needs the latest desktop app.`
        : connection.status === "connected" ? aiReady === null ? "Checking your AI tools…" : `${connection.computer?.name ?? "Your computer"} is connected. Sign in to an AI tool on it.`
        : "No computer connected yet.",
      action: connection.status === "error" ? { label: "Try again", run: () => connection.refresh() }
        : connection.status === "connected" ? { label: "Set up AI", run: onSetUpAi }
        : connection.status === "checking" ? undefined
        : { label: connection.status === "offline" ? "Reconnect computer" : connection.status === "update" ? "Update computer" : "Connect computer", run: onConnectComputer },
    },
    {
      id: "task",
      title: "Run your first AI task",
      why: "Ask for one small, clear change. The agent commits it to your room’s branch; you review it under Changes before anything is published.",
      done: progress.myTasks > 0,
      action: openRoom,
    },
  ];
  if (manager) {
    steps.push({
      id: "invite",
      title: "Invite a teammate",
      why: "An invitation adds someone to the team. Add them to your project too, so they get a room there and can follow and pick up your chats.",
      done: progress.projectTeammate,
      state: progress.members > 1 ? "Someone has joined the team. Add them to your project so they can work in it."
        : progress.pendingInvites > 0 ? `${progress.pendingInvites === 1 ? "An invitation is" : `${progress.pendingInvites} invitations are`} waiting to be accepted.` : undefined,
      action: progress.members > 1 && firstProject ? { label: "Add to project", run: () => onManageMembers(firstProject) } : { label: "Invite a teammate", run: onInvite },
    });
  }
  steps.push({
    id: "together",
    title: "Finish a task together",
    why: "Your teammate opens your chat to follow it live, reviews its changes, or takes it over with a handoff and finishes it with their own AI. When the team is happy, publish the room’s changes to the project.",
    done: progress.taskPeople >= 2,
  });
  return steps;
}

export function GettingStarted({ org, userId, progress, connection, projects, onNewProject, onInvite, onOpenRoom, onManageMembers, onConnectComputer, onSetUpAi, onVisible, onCoversConnection }: {
  org: Org;
  userId: string;
  progress: OrgOnboarding | null;
  connection: ComputerConnection;
  projects: Project[] | null;
  onNewProject: () => void;
  onInvite: () => void;
  /** Opens your room in a project; rejects with a message to show. */
  onOpenRoom: (project: Project) => Promise<void>;
  onManageMembers: (project: Project) => void;
  onConnectComputer: () => void;
  onSetUpAi: () => void;
  /** Whether the guide is showing, so the page can step its own buttons back. */
  onVisible?: (visible: boolean) => void;
  /** Whether the guide shows connecting as a step to come, so the page can drop its own prompt for it. */
  onCoversConnection?: (covers: boolean) => void;
}) {
  const aiReady = useAiReady(connection);
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(hiddenKey(org, userId)) === "1"; } catch { return false; }
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstProject = projects?.find(project => project.myRole !== "viewer" && project.isMember !== false) ?? null;
  const steps = progress ? guideSteps({ org, progress, connection, aiReady, firstProject, onNewProject, onInvite, onOpenRoom, onManageMembers, onConnectComputer, onSetUpAi }) : [];
  const done = steps.filter(step => step.done).length;
  const current = steps.find(step => !step.done) ?? null;
  const visible = !!progress && !hidden && current !== null;
  const covers = visible && steps.some(step => step.id === "computer" && !step.done);
  useEffect(() => { onVisible?.(visible); }, [visible, onVisible]);
  useEffect(() => { onCoversConnection?.(covers); }, [covers, onCoversConnection]);
  if (!visible) return null;

  async function run(step: Step) {
    if (!step.action || busy) return;
    setBusy(step.id);
    setError(null);
    try { await step.action.run(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That didn’t work. Please try again."); }
    finally { setBusy(null); }
  }
  function hide() {
    setHidden(true);
    try { localStorage.setItem(hiddenKey(org, userId), "1"); } catch {}
  }

  return (
    <section aria-labelledby="guide-heading" className="mt-6 rounded-2xl border border-vs-accent/30 bg-vs-panel p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-vs-muted">Getting started · {done} of {steps.length} done</p>
          <h2 id="guide-heading" className="font-display mt-1.5 text-base font-semibold tracking-tight">Your team’s first shared task</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-vs-muted">Each step unlocks the next. Progress is saved as you go, here and on your other devices.</p>
        </div>
        <button type="button" onClick={hide} className="rounded-lg px-2 py-1 text-xs text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg">Hide guide</button>
      </div>
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-vs-editor" aria-hidden="true">
        <div className="h-full rounded-full bg-vs-accent transition-[width]" style={{ width: `${(done / steps.length) * 100}%` }} />
      </div>
      <ol className="mt-4 space-y-2">
        {steps.map((step, index) => {
          const isCurrent = step === current;
          return (
            <li key={step.id} data-step={step.id} data-state={step.done ? "done" : isCurrent ? "current" : "todo"} aria-current={isCurrent ? "step" : undefined}
              className={`rounded-xl border ${isCurrent ? "border-vs-accent/50 bg-vs-editor p-4" : "border-vs-border px-4 py-2.5"}`}>
              <div className="flex items-center gap-3">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${step.done ? "border-vs-success/40 bg-vs-success/15 text-vs-success" : isCurrent ? "border-vs-accent text-vs-accent" : "border-vs-border text-vs-muted"}`}>
                  {step.done ? <CheckIcon className="h-3 w-3" /> : index + 1}
                </span>
                <p className={`min-w-0 flex-1 text-[13px] ${step.done ? "text-vs-muted" : isCurrent ? "font-semibold text-vs-fg" : "text-vs-fg"}`}>
                  {step.title}
                  <span className="sr-only">{step.done ? " · done" : isCurrent ? " · next step" : " · not started"}</span>
                </p>
                {step.done && <span className="shrink-0 text-[11px] text-vs-success" aria-hidden="true">Done</span>}
              </div>
              {isCurrent && (
                <div className="mt-2.5 space-y-3 pl-9">
                  <p className="max-w-2xl text-xs leading-5 text-vs-muted">{step.why}</p>
                  {step.state && <p role="status" className="text-xs font-medium leading-5 text-vs-fg">{step.state}</p>}
                  {error && <ErrorNote>{error}</ErrorNote>}
                  <div className="flex flex-wrap items-center gap-2">
                    {step.action && (
                      <PrimaryButton disabled={busy !== null} onClick={() => void run(step)}>
                        {busy === step.id && <SpinnerIcon className="h-3.5 w-3.5" />}{step.action.label}
                      </PrimaryButton>
                    )}
                    {step.id === "together" && <Link href="/docs/sharing" className="text-xs text-vs-accent underline underline-offset-4">How sharing and handoffs work</Link>}
                    {step.id === "computer" && <Link href="/docs/prerequisites" className="text-xs text-vs-accent underline underline-offset-4">What you need</Link>}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** How a team, its projects, rooms and chats fit together, in plain words. */
export function HowItFits({ open }: { open: boolean }) {
  return (
    <section className="workspace-welcome mt-6 rounded-2xl border border-vs-border p-5 sm:p-6" aria-labelledby="workflow-heading">
      <details open={open}>
        <summary className="cursor-pointer rounded-lg text-sm font-semibold tracking-tight">
          <span id="workflow-heading" className="font-display">How your team’s work fits together</span>
        </summary>
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Team", "Your organization: its people and projects. Invite someone to the team first."],
            ["Project", "One product or codebase, with its repositories. Only people added to it can open it."],
            ["Room", "Your own space in a project, on its own Git branch. Review its changes, then publish them to the project."],
            ["Chat", "A conversation with an AI agent in a room. Teammates can follow it live, review it, or take it over."],
          ].map(([term, description]) => (
            <div key={term} className="rounded-xl border border-vs-border bg-vs-editor/60 p-3">
              <dt className="font-medium text-vs-fg">{term}</dt>
              <dd className="mt-1 leading-5 text-vs-muted">{description}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
