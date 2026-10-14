"use client";

import {
  ChatIcon,
  FileIcon,
  FilesIcon,
  GitBranchIcon,
  ShieldIcon,
  TerminalIcon,
  UsersIcon,
} from "../icons";

const FEATURES = [
  {
    icon: <FilesIcon className="h-4 w-4" />,
    title: "Explorer that reads real folders",
    body: "Open a Git repository or a plain folder straight from disk. The full tree is listed, with dependency and build directories skipped until you ask for them.",
  },
  {
    icon: <GitBranchIcon className="h-4 w-4" />,
    title: "Git state, detected",
    body: "Current branch, HEAD, remote and every local branch are read from .git — including packed refs, detached HEAD and linked worktrees.",
  },
  {
    icon: <FileIcon className="h-4 w-4" />,
    title: "Editor with live highlighting",
    body: "Tabs, breadcrumbs, a line-number gutter and syntax highlighting for the common language families. Binary and oversized files are handled, not crashed on.",
  },
  {
    icon: <TerminalIcon className="h-4 w-4" />,
    title: "Terminal on the host machine",
    body: "Run commands with streamed output, real exit codes, ANSI colour and Ctrl+C. Loopback-only and development-gated, because it is a real shell.",
  },
  {
    icon: <ChatIcon className="h-4 w-4" />,
    title: "Team chat",
    body: "A side channel next to the code you are both looking at.",
    badge: "Preview",
  },
  {
    icon: <UsersIcon className="h-4 w-4" />,
    title: "Per-teammate AI",
    body: "Pick a teammate and talk to their AI about the open file or a diff.",
    badge: "Preview",
  },
];

const STEPS = [
  {
    title: "Create a session",
    body: "Name it and point it at a project folder. One session holds one project.",
  },
  {
    title: "Work in it",
    body: "Browse the tree, edit files, run commands — all against the folder you opened.",
  },
  {
    title: "Invite who needs it",
    body: "Share the session link plus its access code. Both are needed to get in.",
  },
];

export function LandingContent() {
  return (
    <div className="mx-auto w-full max-w-4xl px-8 py-14">
      <section>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-vs-border bg-vs-panel px-2.5 py-1 text-[12px] font-medium text-vs-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-vs-success" />
          Local-first collaborative workspace
        </span>

        <h1 className="font-display mt-5 text-balance text-5xl font-semibold leading-[1.05] tracking-[-0.02em]">
          Open a repo, bring your team,
          <br />
          <span className="text-vs-muted">keep the code on your machine.</span>
        </h1>

        <p className="mt-5 max-w-2xl text-base leading-7 text-vs-muted">
          multicode-ai is a code workspace that runs in the browser and reads your folders
          directly from disk. Every project opens in its own session, and a session only opens for
          someone holding both its link and its access code.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-vs-muted">
          <span className="flex items-center gap-1.5">
            <ShieldIcon className="h-3.5 w-3.5 text-vs-accent" />
            Files never leave the browser
          </span>
          <span className="flex items-center gap-1.5">
            <GitBranchIcon className="h-3.5 w-3.5 text-vs-accent" />
            Branch detected automatically
          </span>
          <span className="flex items-center gap-1.5">
            <TerminalIcon className="h-3.5 w-3.5 text-vs-accent" />
            Real shell, not a simulation
          </span>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-vs-muted">
          What is inside a session
        </h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <article
              key={feature.title}
              className="rounded-xl border border-vs-border bg-vs-panel/50 p-4 transition hover:border-vs-accent/40"
            >
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-vs-accent/12 text-vs-accent">
                  {feature.icon}
                </span>
                <h3 className="font-display min-w-0 flex-1 truncate text-[16px] font-semibold tracking-tight">
                  {feature.title}
                </h3>
                {feature.badge && (
                  <span className="shrink-0 rounded border border-vs-border px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-vs-muted">
                    {feature.badge}
                  </span>
                )}
              </div>
              <p className="mt-2.5 text-[14px] leading-6 text-vs-muted">{feature.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-sm font-semibold uppercase tracking-[0.14em] text-vs-muted">
          How it works
        </h2>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-xl border border-vs-border bg-vs-panel/50 p-4">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-vs-accent text-[12px] font-semibold text-vs-accent-fg">
                {index + 1}
              </span>
              <h3 className="font-display mt-3 text-[16px] font-semibold tracking-tight">
                {step.title}
              </h3>
              <p className="mt-1.5 text-[14px] leading-6 text-vs-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-14 rounded-xl border border-vs-border bg-vs-panel/50 p-5">
        <h2 className="font-display flex items-center gap-2 text-base font-semibold tracking-tight">
          <ShieldIcon className="h-4 w-4 text-vs-accent" />
          Why a link alone is not enough
        </h2>
        <p className="mt-2 max-w-2xl text-[14px] leading-6 text-vs-muted">
          The session id in the address bar is not a credential. Access lives in a key your browser
          holds in an httpOnly cookie, which page scripts cannot read and a URL cannot carry. Anyone
          who only has the link — forwarded, pasted into a chat, copied off a screen — lands on a
          locked screen and needs the separate access code to continue.
        </p>
      </section>

      <footer className="mt-14 border-t border-vs-border pt-5 text-sm leading-5 text-vs-muted">
        Every session is a real git repository, not a snapshot — file edits, agent turns, and team
        chat are all committed as they happen, so nothing is lost when the server restarts.
      </footer>
    </div>
  );
}
