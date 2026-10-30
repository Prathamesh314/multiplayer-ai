"use client";

import { LogoMark } from "../LogoMark";
import { useEffect, useRef, useState } from "react";
import { publishRoom, syncRoom } from "../../lib/session/client";
import { canEdit, type Session, type SessionMember } from "../../lib/session/types";
import type { ComputerConnection } from "../ai/useComputerConnection";
import { ArrowIcon, ChatIcon, GitBranchIcon, MoreIcon, UserPlusIcon } from "../icons";
import { PeopleStack } from "./People";

type TopBarProps = {
  onOpenGuide: () => void;
  session: Session;
  onInvite: () => void;
  inviteLabel?: string;
  onLeave: () => void;
  onNavigate: (direction: "back" | "forward") => void;
  navigationPending: boolean;
  folderName: string | null;
  branch: string | null;
  isGit: boolean;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenFolder: () => void;
  /** False once this session owns a repo — a session is seeded exactly once. */
  canOpenFolder: boolean;
  members: SessionMember[];
  repoId: string | null;
  hasRepository: boolean;
  sharedRepository: boolean;
  beforePublish: () => Promise<boolean>;
  onPublished: () => Promise<void>;
  /** The member's computer, where AI tasks and terminals run. */
  computer: ComputerConnection;
  onOpenComputer: () => void;
};

/**
 * One calm row: where you are (room and repository), who is here, whether your
 * computer can run AI, and the one thing most people do next — share. Rarer
 * actions sit under More, so nothing is lost and nothing competes.
 */
export function TopBar({
  onOpenGuide,
  session,
  onInvite,
  inviteLabel = "Invite",
  onLeave,
  onNavigate,
  navigationPending,
  folderName,
  branch,
  isGit,
  terminalOpen,
  onToggleTerminal,
  onOpenFolder,
  canOpenFolder,
  members,
  repoId, hasRepository, sharedRepository, beforePublish, onPublished,
  computer, onOpenComputer,
}: TopBarProps) {
  const publishing = !!session.projectId && hasRepository && canEdit(session.myRole);
  const publish = usePublish({ sessionId: session.id, repoId, beforePublish, onPublished });
  const publishLabel = publish.busy === "publish" ? "Publishing…" : sharedRepository ? "Publish" : "Share repository";
  const syncLabel = publish.busy === "sync" ? "Syncing…" : "Get latest";

  return (
    <header className="room-toolbar flex shrink-0 items-center gap-2 border-b border-vs-border bg-vs-chrome px-2 sm:px-3">
      <nav aria-label="Page history" className="hidden shrink-0 items-center gap-0.5 sm:flex">
        {(["back", "forward"] as const).map(direction => (
          <button
            key={direction}
            type="button"
            aria-label={direction === "back" ? "Go back" : "Go forward"}
            title={direction === "back" ? "Go back" : "Go forward"}
            onClick={() => onNavigate(direction)}
            disabled={navigationPending}
            className="flex h-8 w-8 items-center justify-center rounded-md text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:pointer-events-none disabled:opacity-40"
          >
            <ArrowIcon direction={direction === "back" ? "left" : "right"} className="h-4 w-4" />
          </button>
        ))}
      </nav>
      <button
        type="button"
        onClick={onLeave}
        disabled={navigationPending}
        title="Back to projects"
        aria-label="Back to projects"
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-xs font-semibold text-vs-fg transition hover:bg-vs-hover"
      >
        <LogoMark className="h-[18px] w-[18px]" />
        <span className="hidden whitespace-nowrap xl:inline">
          multicode<span className="text-vs-muted">-ai</span>
        </span>
      </button>

      <span aria-hidden="true" className="hidden text-vs-muted/60 sm:inline">/</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 title={`Room ${session.name}`} className="min-w-0 max-w-56 truncate text-[13px] font-semibold text-vs-fg">
          {session.name}
        </h1>
        {folderName && (
          <span className="hidden min-w-0 items-center gap-1 truncate text-[11.5px] text-vs-muted md:flex" title={isGit && branch ? `Repository ${folderName} · branch ${branch}` : `Repository ${folderName}`}>
            <GitBranchIcon className="h-3 w-3 shrink-0" />
            <span className="truncate">{folderName}</span>
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <ComputerStatus connection={computer} onOpen={onOpenComputer} />
        <div className="hidden sm:block"><PeopleStack members={members} /></div>
        {publishing && (
          <div className="hidden items-center gap-1 md:flex">
            <button type="button" onClick={() => void publish.run("sync")} disabled={publish.busy !== null || !sharedRepository}
              title="Get the selected repository’s latest shared changes"
              className="h-8 rounded-lg px-2 text-xs text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-50">
              {syncLabel}
            </button>
            <button type="button" onClick={() => void publish.run("publish")} disabled={publish.busy !== null}
              title="Share saved changes in the selected repository with project members. Review Changes first."
              className="flex h-8 items-center gap-1 rounded-lg border border-vs-border px-2 text-xs text-vs-fg transition hover:bg-vs-hover disabled:opacity-50">
              <GitBranchIcon className="h-3 w-3" />
              {publishLabel}
            </button>
          </div>
        )}
        {publish.status && (
          <span role="status" title={publish.status.text}
            className={`max-w-24 truncate text-[11px] sm:max-w-56 ${publish.status.tone === "ok" ? "text-vs-success" : "text-vs-danger"}`}>
            {publish.status.text}
          </span>
        )}
        <MoreMenu items={[
          { label: "Room guide", hint: "What each part of the room is for", onSelect: onOpenGuide },
          ...(hasRepository ? [{ label: terminalOpen ? "Hide terminal" : "Show terminal", hint: "Ctrl+` · a shell on your computer", onSelect: onToggleTerminal }] : []),
          ...(publishing ? [
            { label: syncLabel, hint: "The latest shared changes", onSelect: () => void publish.run("sync"), disabled: publish.busy !== null || !sharedRepository, compactOnly: true },
            { label: publishLabel, hint: "Share saved changes with the project", onSelect: () => void publish.run("publish"), disabled: publish.busy !== null, compactOnly: true },
          ] : []),
          ...(canOpenFolder ? [{ label: "Open folder…", hint: "Upload this room’s first folder", onSelect: onOpenFolder }] : []),
        ]} />
        <button
          type="button"
          onClick={onInvite}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-vs-accent px-2.5 text-xs font-medium text-vs-accent-fg transition hover:opacity-90"
        >
          <UserPlusIcon className="h-3.5 w-3.5" />
          {inviteLabel}
        </button>
      </div>
    </header>
  );
}

/**
 * Your computer, as one chip: green only when it is really connected. The
 * words come from the same check the message box uses, so the two never
 * disagree, and a change is announced once, not on every re-render.
 */
function ComputerStatus({ connection, onOpen }: { connection: ComputerConnection; onOpen: () => void }) {
  const { status, computer, checking, refresh } = connection;
  const name = computer?.name ?? "Your computer";
  const [label, detail, dot] =
    status === "connected" ? [name, `${name} is connected. AI tasks and the terminal run on it.`, "bg-vs-success"]
    : status === "checking" ? ["Checking computer…", "Checking whether your computer is connected.", "bg-vs-muted"]
    : status === "offline" ? ["Computer offline", `${name} is closed, paused or asleep. Reading and reviewing still work.`, "bg-vs-warn"]
    : status === "update" ? ["Update needed", "Your computer’s app is older than this workspace. Update it to run AI.", "bg-vs-warn"]
    : status === "error" ? ["Couldn’t check computer", "The connection check failed. Check your internet connection.", "bg-vs-danger"]
    : ["No computer", "AI tasks run on your computer. Connect it to send messages; reading and reviewing work without it.", "bg-vs-warn"];
  const retry = status === "error";
  return (
    <>
      <button
        type="button"
        data-computer-status={status}
        onClick={retry ? () => void refresh() : onOpen}
        disabled={retry && checking}
        title={`${detail} ${retry ? "Select to try again." : "Select to manage computers."}`}
        aria-label={`${label}. ${retry ? "Try again" : "Manage computers"}`}
        className="flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-[11.5px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg disabled:opacity-60"
      >
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full transition-colors ${dot}`} />
        <span className="hidden max-w-36 truncate lg:inline">{label}</span>
      </button>
      {/* Announced when the state changes; "checking" is a moment, not news. */}
      <span className="sr-only" role="status" aria-live="polite">{status === "checking" ? "" : `Computer: ${label}`}</span>
    </>
  );
}

type MenuItem = { label: string; hint?: string; onSelect: () => void; disabled?: boolean; compactOnly?: boolean };

/** Rarer room actions: opened with a click or the keyboard, closed with Escape. */
function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return (
    <div ref={root} className="relative shrink-0">
      <button ref={trigger} type="button" aria-label="More room actions" title="More" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg">
        <MoreIcon className="h-4 w-4" />
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label="More room actions"
          onKeyDown={event => {
            if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); return; }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)")).filter(button => button.offsetParent !== null);
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }}
          className="absolute right-0 top-full z-40 mt-1 w-52 rounded-xl border border-vs-border bg-vs-panel p-1 shadow-[0_14px_40px_rgb(0_0_0_/_0.45)]">
          {items.map(item => (
            <button key={item.label} type="button" role="menuitem" disabled={item.disabled} title={item.hint}
              onClick={() => { close(); item.onSelect(); }}
              className={`${item.compactOnly ? "flex md:hidden" : "flex"} min-h-9 w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-vs-fg transition hover:bg-vs-hover focus-visible:bg-vs-hover disabled:opacity-40`}>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Get latest and Publish for the selected repository, and what happened last. */
function usePublish({ sessionId, repoId, beforePublish, onPublished }: { sessionId: string; repoId: string | null; beforePublish: () => Promise<boolean>; onPublished: () => Promise<void> }) {
  const [busy, setBusy] = useState<"publish" | "sync" | null>(null);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  // Another repository's outcome is not this one's.
  const [shownFor, setShownFor] = useState(repoId);
  if (shownFor !== repoId) { setShownFor(repoId); setStatus(null); }

  async function run(kind: "publish" | "sync") {
    setBusy(kind);
    setStatus(null);
    try {
      if (!await beforePublish()) throw new Error("Save or resolve your edits first.");
      const outcome = await (kind === "publish" ? publishRoom(sessionId, repoId) : syncRoom(sessionId, repoId));
      if (outcome.ok) {
        await onPublished();
        setStatus({ tone: "ok", text: kind === "publish" ? "Published to project" : "Up to date with project" });
      } else {
        setStatus({
          tone: "error",
          text: `Conflict in ${outcome.files.slice(0, 2).join(", ")}${outcome.files.length > 2 ? "…" : ""} — resolve it in the room first`,
        });
      }
    } catch (cause) {
      setStatus({ tone: "error", text: cause instanceof Error ? cause.message : "Something went wrong." });
    } finally {
      setBusy(null);
      setTimeout(() => setStatus(null), 6000);
    }
  }
  return { busy, status, run };
}

/** The phone-width switch between the conversation, the files and the room's chats. */
export function RoomViews({ pane, onPane, changeCount, hasFiles }: {
  pane: "chat" | "files" | "team";
  onPane: (pane: "chat" | "files" | "team") => void;
  changeCount: number;
  hasFiles: boolean;
}) {
  const views = [
    { id: "chat" as const, label: "Conversation" },
    ...(hasFiles ? [{ id: "files" as const, label: changeCount ? `Files · ${changeCount} changed` : "Files" }] : []),
    { id: "team" as const, label: "Chats" },
  ];
  return (
    <nav aria-label="Room views" className="flex shrink-0 gap-1 border-b border-vs-border bg-vs-chrome px-2 py-1.5 lg:hidden">
      {views.map(view => (
        <button key={view.id} type="button" aria-current={pane === view.id ? "page" : undefined} onClick={() => onPane(view.id)}
          className={`flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-[12.5px] transition ${pane === view.id ? "bg-vs-active font-medium text-vs-fg" : "text-vs-muted hover:bg-vs-hover hover:text-vs-fg"}`}>
          {view.id === "chat" && <ChatIcon className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{view.label}</span>
        </button>
      ))}
    </nav>
  );
}
