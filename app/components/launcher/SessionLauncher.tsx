"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { relativeTime } from "../../lib/format";
import {
  createSession,
  joinSession,
  listMySessions,
  parseSessionId,
} from "../../lib/session/client";
import type { Session } from "../../lib/session/types";
import {
  AlertIcon,
  ChevronIcon,
  FolderUpIcon,
  GitBranchIcon,
  SparkleIcon,
  SpinnerIcon,
  TerminalIcon,
} from "../icons";

export function SessionLauncher() {
  const router = useRouter();
  const [mine, setMine] = useState<Session[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMySessions()
      .then((sessions) => !cancelled && setMine(sessions))
      .catch(() => !cancelled && setMine([]));
    return () => {
      cancelled = true;
    };
  }, []);

  function open(id: string) {
    router.push(`/s/${id}`);
  }

  return (
    <main className="min-h-dvh bg-vs-editor text-vs-fg">
      <div className="mx-auto w-full max-w-5xl px-6 py-14">
        <header className="flex flex-col gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <SparkleIcon className="h-5 w-5 text-vs-accent" />
            <span className="whitespace-nowrap">
              multiplayer<span className="text-vs-muted">-ai</span>
            </span>
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Start a session</h1>
          <p className="max-w-2xl text-sm leading-6 text-vs-muted">
            A session is one workspace: one project folder, its Git branch, a terminal, and the
            teammates you invite. Open a second project by starting a second session.
          </p>
        </header>

        <div className="mt-9 grid gap-4 md:grid-cols-2">
          <CreateCard onCreated={open} />
          <JoinCard onJoined={open} />
        </div>

        <FeatureRow />

        <MySessions sessions={mine} onOpen={open} />
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------

function CreateCard({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const session = await createSession(name.trim() || undefined);
      onCreated(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create a session.");
      setBusy(false);
    }
  }

  return (
    <Card
      title="Create a session"
      description="Start fresh, open a folder, then invite the people who should see it."
    >
      <label className="block text-xs font-medium uppercase tracking-wide text-vs-muted">
        Session name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) void create();
          }}
          placeholder="Checkout refactor"
          maxLength={60}
          className="mt-1.5 w-full rounded-lg border border-vs-border bg-vs-panel px-3 py-2 text-sm font-normal normal-case tracking-normal text-vs-fg outline-none placeholder:text-vs-muted focus:border-vs-accent"
        />
      </label>

      <p className="text-xs text-vs-muted">Optional — one is generated if you leave it blank.</p>

      <button
        type="button"
        onClick={create}
        disabled={busy}
        className="mt-auto flex w-full items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2.5 text-sm font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60"
      >
        {busy ? <SpinnerIcon className="h-4 w-4" /> : null}
        {busy ? "Creating…" : "Create session"}
      </button>

      {error && <ErrorNote>{error}</ErrorNote>}
    </Card>
  );
}

function JoinCard({ onJoined }: { onJoined: (id: string) => void }) {
  const [target, setTarget] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    const id = parseSessionId(target);
    if (!id) {
      setError("Paste a session link or id.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const session = await joinSession(id, code);
      onJoined(session.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join that session.");
      setBusy(false);
    }
  }

  return (
    <Card
      title="Join an existing session"
      description="You need both the link and its access code — a link on its own will not open."
    >
      <label className="block text-xs font-medium uppercase tracking-wide text-vs-muted">
        Session link or id
        <input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder="http://localhost:3000/s/…"
          className="mt-1.5 w-full rounded-lg border border-vs-border bg-vs-panel px-3 py-2 font-mono text-sm font-normal normal-case tracking-normal text-vs-fg outline-none placeholder:text-vs-muted focus:border-vs-accent"
        />
      </label>

      <label className="block text-xs font-medium uppercase tracking-wide text-vs-muted">
        Access code
        <input
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) void join();
          }}
          placeholder="A1B2-C3D4"
          className="mt-1.5 w-full rounded-lg border border-vs-border bg-vs-panel px-3 py-2 font-mono text-sm font-normal tracking-[0.12em] text-vs-fg outline-none placeholder:tracking-normal placeholder:text-vs-muted focus:border-vs-accent"
        />
      </label>

      <button
        type="button"
        onClick={join}
        disabled={busy}
        className="mt-auto flex w-full items-center justify-center gap-2 rounded-lg border border-vs-border px-4 py-2.5 text-sm font-medium transition hover:bg-vs-hover disabled:opacity-60"
      >
        {busy ? <SpinnerIcon className="h-4 w-4" /> : null}
        {busy ? "Joining…" : "Join session"}
      </button>

      {error && <ErrorNote>{error}</ErrorNote>}
    </Card>
  );
}

function MySessions({
  sessions,
  onOpen,
}: {
  sessions: Session[] | null;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="mt-10">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-vs-muted">
        Sessions open on this device
      </h2>

      {sessions === null ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-vs-muted">
          <SpinnerIcon className="h-4 w-4" />
          Checking…
        </p>
      ) : sessions.length === 0 ? (
        <p className="mt-3 max-w-xl text-sm leading-6 text-vs-muted">
          None yet. Sessions are tied to this browser — they do not appear on other devices unless
          you share the link together with its access code.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-vs-border overflow-hidden rounded-xl border border-vs-border">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                onClick={() => onOpen(session.id)}
                className="flex w-full items-center gap-3 bg-vs-panel px-4 py-3 text-left transition hover:bg-vs-hover"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{session.name}</span>
                  <span className="mt-0.5 block font-mono text-[11px] text-vs-muted">
                    /s/{session.id} · created {relativeTime(Math.floor(session.createdAt / 1000))}
                  </span>
                </span>
                <ChevronIcon className="h-4 w-4 text-vs-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FeatureRow() {
  const items = [
    { icon: <FolderUpIcon className="h-4 w-4" />, label: "Open a Git repo or plain folder" },
    { icon: <GitBranchIcon className="h-4 w-4" />, label: "Branch detected automatically" },
    { icon: <TerminalIcon className="h-4 w-4" />, label: "Terminal on the host machine" },
  ];

  return (
    <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2 text-xs text-vs-muted">
          <span className="text-vs-accent">{item.icon}</span>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-vs-border bg-vs-panel/60 p-5">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-vs-muted">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-300">
      <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {children}
    </p>
  );
}
