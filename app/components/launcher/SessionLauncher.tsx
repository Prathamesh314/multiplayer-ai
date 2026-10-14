"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { relativeTime } from "../../lib/format";
import { useToast } from "../ui/Toast";
import { fetchMe, logout } from "../../lib/auth/client";
import type { CurrentUser } from "../../lib/auth/types";
import { listMySessions, NotSignedIn } from "../../lib/session/client";
import type { Session } from "../../lib/session/types";
import { LinkIcon, PlusIcon, SparkleIcon, SpinnerIcon } from "../icons";
import { CreateSessionDialog } from "./CreateSessionDialog";
import { JoinSessionDialog } from "./JoinSessionDialog";
import { LandingContent } from "./LandingContent";

type Dialog = "create" | "join" | null;

export function SessionLauncher() {
  const router = useRouter();
  const { notify } = useToast();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const [me, setMe] = useState<CurrentUser | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const list = await listMySessions();
        if (cancelled) return;
        setSessions(list);
        setMe((await fetchMe()).user);
      } catch (cause) {
        if (cancelled) return;
        // Sessions belong to an account now, so there is nothing to show a
        // signed-out visitor here.
        if (cause instanceof NotSignedIn) router.replace("/login");
        else setSessions([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function signOut() {
    try { await logout(); router.replace("/login"); }
    catch { notify({ tone: "error", title: "Couldn’t sign out", description: "Please check your connection and try again." }); }
  }

  function open(sessionId: string) {
    router.push(`/s/${sessionId}`);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-vs-editor text-vs-fg md:h-dvh md:flex-row md:overflow-hidden">
      <Sidebar
        sessions={sessions}
        me={me}
        onSignOut={signOut}
        onOpen={open}
        onCreate={() => setDialog("create")}
        onJoin={() => setDialog("join")}
      />

      <main className="min-w-0 flex-1 md:overflow-y-auto">
        <LandingContent />
      </main>

      {dialog === "create" && (
        <CreateSessionDialog onClose={() => setDialog(null)} onCreated={open} />
      )}
      {dialog === "join" && <JoinSessionDialog onClose={() => setDialog(null)} onJoined={open} />}
    </div>
  );
}

function Sidebar({
  sessions,
  me,
  onSignOut,
  onOpen,
  onCreate,
  onJoin,
}: {
  sessions: Session[] | null;
  me: CurrentUser | null;
  onSignOut: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-vs-border bg-vs-panel md:h-full md:w-72 md:border-b-0 md:border-r">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-vs-border px-4">
        <SparkleIcon className="h-4 w-4 text-vs-accent" />
        <span className="whitespace-nowrap text-[14px] font-semibold">
          multicode<span className="text-vs-muted">-ai</span>
        </span>
      </header>

      <div className="shrink-0 space-y-2 border-b border-vs-border p-3">
        <button
          type="button"
          onClick={onCreate}
          className="flex w-full items-center gap-2 rounded-lg bg-vs-accent px-3 py-2.5 text-base font-medium text-vs-accent-fg transition hover:opacity-90"
        >
          <PlusIcon className="h-4 w-4" />
          New session
        </button>
        <button
          type="button"
          onClick={onJoin}
          className="flex w-full items-center gap-2 rounded-lg border border-vs-border px-3 py-2.5 text-base transition hover:bg-vs-hover"
        >
          <LinkIcon className="h-4 w-4 text-vs-muted" />
          Join a session
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <h2 className="shrink-0 px-4 pb-1 pt-3 text-[12px] font-semibold uppercase tracking-wider text-vs-muted">
          Your sessions
          {sessions && sessions.length > 0 && (
            <span className="ml-1.5 font-normal normal-case tracking-normal">
              ({sessions.length})
            </span>
          )}
        </h2>

        <div className="vs-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {sessions === null ? (
            <p className="flex items-center gap-2 px-2 py-2 text-sm text-vs-muted">
              <SpinnerIcon className="h-3.5 w-3.5" />
              Checking…
            </p>
          ) : sessions.length === 0 ? (
            <p className="px-2 py-2 text-sm leading-5 text-vs-muted">
              No sessions yet. Create one to open a project, or join one you were invited to.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((session) => (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(session.id)}
                    title={`/s/${session.id}`}
                    className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-vs-hover"
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-vs-accent/12 text-[12px] font-semibold uppercase text-vs-accent">
                      {initialsOf(session.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px]">{session.name}</span>
                      <span className="block truncate text-[12px] text-vs-muted">
                        {relativeTime(Math.floor(session.createdAt / 1000))}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <footer className="flex shrink-0 items-center gap-2.5 border-t border-vs-border px-3 py-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-vs-accent/12 text-[12px] font-semibold uppercase text-vs-accent">
          {me ? initialsOf(me.displayName) : "?"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px]">{me?.displayName ?? "Signed out"}</span>
          <span className="block truncate font-mono text-[12px] text-vs-muted">
            {me ? `@${me.handle}` : ""}
          </span>
        </span>
        <a href="/account" className="rounded-lg px-3 py-2 text-sm text-vs-muted hover:text-vs-fg">Account settings</a>
<button
          type="button"
          onClick={onSignOut}
          className="shrink-0 rounded px-2 py-1 text-[12px] text-vs-muted transition hover:bg-vs-hover hover:text-vs-fg"
        >
          Sign out
        </button>
      </footer>
    </aside>
  );
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "S";
  if (words.length === 1) return words[0].slice(0, 2);
  return `${words[0][0]}${words[1][0]}`;
}
