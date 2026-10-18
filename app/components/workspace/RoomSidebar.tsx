"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorNote, GhostButton, Modal } from "../ui/Modal";
import type { AgentRun } from "../../lib/ai/runs";
import { archiveRun, renameRun } from "../../lib/ai/runs-client";
import { relativeTime } from "../../lib/format";
import type { ChatMessage, SessionMember } from "../../lib/session/types";
import { CheckIcon, ChevronIcon, FolderPlusIcon, GitBranchIcon, LinkIcon, PlusIcon, SpinnerIcon } from "../icons";
import { useTitleTransition } from "./useTitleTransition";

type RoomSidebarProps = {
  sessionId: string;
  /** This room's name, for building copyable `@room/<run-id>` chat paths. */
  roomName: string;
  members: SessionMember[];
  /** The signed-in user's id, for marking their own folder. */
  myUserId: string | null;
  incoming: ChatMessage[];
  runs: AgentRun[];
  /**
   * The room's repos, picker-ordered: the room's own (id "") first, then each
   * import. With more than one, a person's chats are sub-grouped per repo so
   * different codebases and their conversations stay visually separate.
   */
  repos: RepoOption[];
  enteredRunId: string | null;
  onEnter: (run: AgentRun) => void;
  onNewRun: (repoId: string | null) => void;
  onAddRepository: () => void;
  importing?: boolean;
  canAdd?: boolean;
  onFork: (run: AgentRun) => void;
  /** Reload the runs after one is renamed. */
  onRenamed: () => void;
  /** Make a repository you added private to you (true) or visible to the room (false). */
  onRepoVisibility?: (repoId: string, makePrivate: boolean) => Promise<void>;
  /** Delete a repository from the room, with its chats. */
  onDeleteRepo?: (repoId: string) => Promise<void>;
};
type RepoOption = { id: string; label: string; private?: boolean; canChangeVisibility?: boolean; canDelete?: boolean };

function LockIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}><rect x="3.25" y="7" width="9.5" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" /><path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.4" /></svg>;
}

/** The "…" menu of one repository: who sees it, and deleting it. */
function RepoMenu({ repo, chats, onVisibility, onDelete }: {
  repo: RepoOption; chats: number;
  onVisibility?: (repoId: string, makePrivate: boolean) => Promise<void>;
  onDelete?: (repoId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [open]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); setConfirming(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const item = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-vs-fg transition hover:bg-vs-hover";
  return (
    <div ref={root} className="relative">
      <button type="button" aria-label={`Options for ${repo.label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg focus-visible:outline-2 focus-visible:outline-vs-accent">
        <span aria-hidden className="text-base leading-none">⋯</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-60 rounded-xl border border-vs-border bg-vs-panel p-1 shadow-[0_14px_40px_rgb(0_0_0_/_0.45)]">
          {repo.canChangeVisibility && onVisibility && (
            <button type="button" role="menuitem" disabled={busy} className={item}
              onClick={() => { setOpen(false); void run(() => onVisibility(repo.id, !repo.private)); }}>
              <LockIcon className="h-3.5 w-3.5 text-vs-muted" />
              <span className="min-w-0 flex-1">
                <span className="block">{repo.private ? "Show to the room" : "Make private"}</span>
                <span className="block text-[11px] text-vs-muted">{repo.private ? "Everyone in the room sees it and its chats" : "Only you see it, its files and its chats"}</span>
              </span>
            </button>
          )}
          {repo.canDelete && onDelete && (
            <button type="button" role="menuitem" className={`${item} hover:text-vs-danger`} onClick={() => { setOpen(false); setError(null); setConfirming(true); }}>
              <span aria-hidden className="w-3.5 text-center">✕</span>Delete repository…
            </button>
          )}
        </div>
      )}
      {error && !confirming && <p role="alert" className="absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-vs-danger/30 bg-vs-panel p-2 text-[11px] leading-4 text-vs-danger">{error}</p>}
      {confirming && onDelete && (
        <Modal title={`Delete “${repo.label}”?`} description="Removes it from this room for everyone. This can’t be undone." onClose={() => !busy && setConfirming(false)}
          footer={<><GhostButton disabled={busy} onClick={() => setConfirming(false)}>Cancel</GhostButton>
            <button type="button" disabled={busy} onClick={() => void run(() => onDelete(repo.id))}
              className="inline-flex min-h-8 items-center justify-center rounded-lg bg-vs-danger px-3 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50">
              {busy ? "Deleting…" : "Delete repository"}
            </button></>}>
          <p className="text-sm leading-6 text-vs-muted">
            {chats ? `Its ${chats} chat${chats === 1 ? "" : "s"} will be deleted too. ` : "It has no chats. "}
            Its files in this room go as well. A repository shared from the project stays in the project.
          </p>
          {error && <ErrorNote>{error}</ErrorNote>}
        </Modal>
      )}
    </div>
  );
}

/** Repository-first navigation, backed by the room's live runs. */
export function RoomSidebar({ sessionId, roomName, members, myUserId, runs, repos, enteredRunId, onEnter, onNewRun, onFork, onRenamed, onAddRepository, importing, canAdd = true, onRepoVisibility, onDeleteRepo }: RoomSidebarProps) {
  const myId = myUserId ?? members.find(member => member.isSelf)?.userId ?? null;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(() => new Set());
  // Copy an `@room/<run-id>` path to reference this chat from another room's
  // composer — the id is what the server resolves, the name is just readable.
  function copyPath(run: AgentRun) {
    const path = `@${roomName}/${run.id}`;
    void navigator.clipboard
      ?.writeText(path)
      .then(() => {
        setCopiedId(run.id);
        window.setTimeout(() => setCopiedId((id) => (id === run.id ? null : id)), 1200);
      })
      .catch(() => {});
  }
  async function commitRename(run: AgentRun) {
    const title = draft.trim();
    setEditingId(null);
    if (title && title !== run.title) {
      try {
        await renameRun(sessionId, run.id, title);
        onRenamed();
      } catch {
        // Leave the old name in place on failure.
      }
    }
  }

  async function toggleArchive(run: AgentRun, archived: boolean) {
    try {
      await archiveRun(sessionId, run.id, archived);
      onRenamed(); // refreshes the room's run list
    } catch {
      // Leave it as-is on failure.
    }
  }

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  /** One chat row. `self` unlocks rename/archive; others' rows offer fork. */
  const renderRun = (run: AgentRun, self: boolean) => {
    const active = run.id === enteredRunId;
    const archived = !!run.archivedAt;

    if (editingId === run.id) {
      return (
        <div key={run.id} className="flex min-h-10 min-w-0 items-center gap-3 rounded-md px-2 py-1">
          <GitBranchIcon className="h-3.5 w-3.5 shrink-0 text-vs-accent" />
          <input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commitRename(run)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitRename(run);
              } else if (event.key === "Escape") {
                setEditingId(null);
              }
            }}
            className="min-w-0 flex-1 rounded border border-vs-accent bg-vs-editor px-1.5 py-0.5 text-[13px] text-vs-fg outline-none"
          />
        </div>
      );
    }

    return (
      <div
        key={run.id}
        className={`group flex w-full min-w-0 items-center gap-1 rounded-lg pr-1 transition ${
          active ? "bg-vs-active" : "hover:bg-vs-hover"
        }`}
      >
        <button
          type="button"
          onClick={() => onEnter(run)}
          onDoubleClick={() => {
            if (self && !archived) {
              setDraft(run.title ?? "");
              setEditingId(run.id);
            }
          }}
          title={`${run.title ?? "Agent run"} · ${run.agentId} · ${run.status} · ${relativeTime(Math.floor(run.createdAt / 1000))}`}
          className={`flex min-h-8 min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left ${
            active ? "text-vs-fg" : "text-vs-muted"
          }`}
        >
          {run.status === "running" ? (
            <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-vs-warn" />
          ) : (
            <GitBranchIcon
              className={`h-3.5 w-3.5 shrink-0 ${
                active
                  ? "text-vs-accent"
                  : run.status === "failed"
                    ? "text-vs-danger"
                    : "text-vs-muted"
              }`}
            />
          )}
          <RunTitle runId={run.id} title={run.title ?? `${run.agentId} run`} />
          <DiffStat added={run.addedLines} removed={run.removedLines} />
          <BranchChip run={run} />
        </button>

        <div className="hidden shrink-0 items-center group-hover:flex group-focus-within:flex">
          <IconButton
            onClick={() => copyPath(run)}
            title={`Copy chat path (@${roomName}/…) to reference it from another room`}
            label="Copy chat path"
          >
            {copiedId === run.id ? (
              <CheckIcon className="h-3.5 w-3.5 text-vs-success" />
            ) : (
              <LinkIcon className="h-3.5 w-3.5" />
            )}
          </IconButton>

          {self ? (
            archived ? (
              <IconButton
                onClick={() => void toggleArchive(run, false)}
                title="Restore this chat"
                label="Restore chat"
              >
                <UnarchiveIcon className="h-3.5 w-3.5" />
              </IconButton>
            ) : (
              <>
                <IconButton
                  onClick={() => {
                    setDraft(run.title ?? "");
                    setEditingId(run.id);
                  }}
                  title="Rename"
                  label="Rename chat"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  onClick={() => void toggleArchive(run, true)}
                  title="Archive this chat"
                  label="Archive chat"
                >
                  <ArchiveIcon className="h-3.5 w-3.5" />
                </IconButton>
              </>
            )
          ) : (
            <IconButton
              onClick={() => onFork(run)}
              title="Fork: start a new chat that imports this chat's context"
              label="Fork this chat into a new one with its context"
            >
              <GitBranchIcon className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
      </div>
    );
  };

  const groups: RepoOption[] = [...repos, ...Array.from(new Set(runs.map(run => run.repoId ?? "")))
    .filter(id => !repos.some(repo => repo.id === id)).map(id => ({ id, label: "Unavailable repository" }))];
  return (
    <aside aria-label="Repositories and chats" className="flex h-full min-h-0 min-w-0 flex-col bg-vs-panel">
      <header className="flex min-h-8 shrink-0 items-center justify-between gap-2 px-3 py-1">
        <h2 className="text-xs font-medium text-vs-muted">Repositories &amp; chats</h2>
        <button type="button" aria-label="Add repository" aria-busy={importing} title={importing ? "Importing repository…" : "Add repository"} onClick={onAddRepository} disabled={!canAdd || importing} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg focus-visible:outline-2 focus-visible:outline-vs-accent disabled:opacity-50">
          {importing ? <SpinnerIcon className="h-4 w-4" /> : <FolderPlusIcon className="h-4 w-4" />}
        </button>
      </header>
      <div className="vs-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.map(repo => {
          const active = runs.filter(run => (run.repoId ?? "") === repo.id && !run.archivedAt);
          const archived = runs.filter(run => (run.repoId ?? "") === repo.id && run.archivedAt && run.driverUserId === myId);
          const open = !collapsed.has(repo.id);
          return <section key={repo.id} className="mb-2">
            <div className="flex min-h-7 items-center gap-1 rounded-lg hover:bg-vs-hover">
              <button type="button" aria-expanded={open} onClick={() => setCollapsed(value => toggle(value, repo.id))} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1.5 text-left text-[12.5px] font-medium leading-[20px] text-vs-muted hover:text-vs-fg">
                <ChevronIcon className={`h-3 w-3 shrink-0 ${open ? "rotate-90" : ""}`} />
                <span className="min-w-0 flex-1 truncate">{repo.label}</span>
                {repo.private && <span title="Private: only you see it" className="flex shrink-0 items-center"><LockIcon className="h-3 w-3 text-vs-muted" /><span className="sr-only">Private</span></span>}
                <span className="text-[11px] font-normal tabular-nums">{active.length}</span>
              </button>
              {(repo.canChangeVisibility || repo.canDelete) && (
                <RepoMenu repo={repo} chats={runs.filter(run => (run.repoId ?? "") === repo.id).length} onVisibility={onRepoVisibility} onDelete={onDeleteRepo} />
              )}
              <button type="button" aria-label={`New chat in ${repo.label}`} title={`New chat in ${repo.label}`} disabled={!canAdd || importing || !repos.some(item => item.id === repo.id)} onClick={() => onNewRun(repo.id || null)} className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg focus-visible:outline-2 focus-visible:outline-vs-accent disabled:opacity-40"><PlusIcon className="h-4 w-4" /></button>
            </div>
            {open && <div className="ml-2 mt-1">
              {active.map(run => renderRun(run, run.driverUserId === myId))}
              {!active.length && <p className="px-3 py-2 text-xs text-vs-muted">No chats yet</p>}
              {!!archived.length && <><button type="button" aria-expanded={archivedOpen.has(repo.id)} onClick={() => setArchivedOpen(value => toggle(value, repo.id))} className="px-2 py-1 text-[11px] text-vs-muted">{archivedOpen.has(repo.id) ? "▾" : "›"} Archived · {archived.length}</button>{archivedOpen.has(repo.id) && archived.map(run => renderRun(run, true))}</>}
            </div>}
          </section>;
        })}
        {!groups.length && <p className="px-3 text-xs leading-5 text-vs-muted">Start without files, or import a folder using Add repository above.</p>}
      </div>
    </aside>
  );
}

/**
 * A chat's name in the list, cross-faded when it changes — so the row a
 * freshly started chat occupies visibly settles on its name rather than
 * flicking from the raw prompt to something else.
 */
function RunTitle({ runId, title }: { runId: string; title: string }) {
  const { shown, className } = useTitleTransition(title, runId);
  return <span className={`${className} min-w-0 flex-1 truncate text-[12.5px] leading-[20px]`}>{shown}</span>;
}

/** A hover-revealed icon action on a chat row. */
function IconButton({
  onClick,
  title,
  label,
  children,
}: {
  onClick: () => void;
  title: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className="shrink-0 rounded p-1 text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
    >
      {children}
    </button>
  );
}

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className={className}>
      <path d="M11.5 2.5a1.4 1.4 0 0 1 2 2L6 12l-3 1 1-3 7.5-7.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function ArchiveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className={className}>
      <rect x="2" y="3" width="12" height="3" rx="0.5" />
      <path d="M3 6.5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6" strokeLinejoin="round" />
      <path d="M6.5 9h3" strokeLinecap="round" />
    </svg>
  );
}

function UnarchiveIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden className={className}>
      <rect x="2" y="3" width="12" height="3" rx="0.5" />
      <path d="M3 6.5v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-6" strokeLinejoin="round" />
      <path d="M8 12V8.5M8 8.5 6.5 10M8 8.5 9.5 10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Where a parallel chat's own branch stands: work to review, merged into the
 * room, or discarded. Ordinary chats work on the room branch and show nothing.
 */
function BranchChip({ run }: { run: AgentRun }) {
  if (run.isolation !== "isolated") return null;
  const changed = !!(run.addedLines || run.removedLines);
  const [label, tone, title] =
    run.mergeState === "merged" ? ["merged", "border-vs-success/40 text-vs-success", "Parallel chat · merged into the room"]
    : run.mergeState === "discarded" ? ["discarded", "border-vs-border text-vs-muted line-through", "Parallel chat · discarded; its branch is kept"]
    : changed && run.status === "completed" ? ["review", "border-vs-accent/40 text-vs-accent", "Parallel chat · changes ready to review and merge"]
    : ["parallel", "border-vs-border text-vs-muted", "Parallel chat · works on a branch of its own"];
  return <span title={title} className={`shrink-0 rounded border px-1 text-[9.5px] leading-[14px] ${tone}`}>{label}</span>;
}

/** A run's diff size, `+added -removed`, shown only when it changed something. */
function DiffStat({ added, removed }: { added: number | null; removed: number | null }) {
  if (!added && !removed) return null;
  return (
    <span className="shrink-0 font-mono text-[10px] tabular-nums">
      {added ? <span className="text-vs-success">+{added}</span> : null}
      {removed ? <span className="ml-1 text-vs-danger">-{removed}</span> : null}
    </span>
  );
}
