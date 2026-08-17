"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { joinSession, loadSession } from "../../lib/session/client";
import type { Session } from "../../lib/session/types";
import { AlertIcon, SparkleIcon, SpinnerIcon } from "../icons";
import { Workspace } from "./Workspace";

type RoomState =
  | { kind: "loading" }
  | { kind: "ready"; session: Session }
  | { kind: "locked"; reason: string }
  | { kind: "error"; message: string };

export function SessionRoom({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<RoomState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadSession(sessionId)
      .then((result) => {
        if (cancelled) return;
        setState(
          result.state === "ready"
            ? { kind: "ready", session: result.session }
            : { kind: "locked", reason: result.reason },
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : "Could not open this session.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (state.kind === "ready") {
    return <Workspace session={state.session} />;
  }

  if (state.kind === "loading") {
    return (
      <Centered>
        <SpinnerIcon className="h-6 w-6 text-vs-accent" />
        <p className="text-sm text-vs-muted">Opening session…</p>
      </Centered>
    );
  }

  if (state.kind === "error") {
    return (
      <Centered>
        <AlertIcon className="h-6 w-6 text-amber-500" />
        <p className="max-w-sm text-center text-sm text-vs-muted">{state.message}</p>
      </Centered>
    );
  }

  return (
    <LockedScreen
      sessionId={sessionId}
      reason={state.reason}
      onUnlocked={(session) => setState({ kind: "ready", session })}
    />
  );
}

function LockedScreen({
  sessionId,
  reason,
  onUnlocked,
}: {
  sessionId: string;
  reason: string;
  onUnlocked: (session: Session) => void;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock() {
    if (!code.trim()) {
      setError("Enter the access code for this session.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onUnlocked(await joinSession(sessionId, code));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not join that session.");
      setBusy(false);
    }
  }

  return (
    <Centered>
      <div className="w-full max-w-md rounded-xl border border-vs-border bg-vs-panel p-6">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <SparkleIcon className="h-4 w-4 text-vs-accent" />
          <span className="whitespace-nowrap">
            multiplayer<span className="text-vs-muted">-ai</span>
          </span>
        </span>

        <h1 className="mt-4 text-lg font-semibold">This session is locked</h1>
        <p className="mt-1.5 text-xs leading-5 text-vs-muted">{reason}</p>

        <p className="mt-4 font-mono text-[11px] text-vs-muted">/s/{sessionId}</p>

        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-vs-muted">
          Access code
          <input
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) void unlock();
            }}
            placeholder="A1B2-C3D4"
            className="mt-1.5 w-full rounded-lg border border-vs-border bg-vs-editor px-3 py-2 font-mono text-sm font-normal tracking-[0.12em] text-vs-fg outline-none placeholder:tracking-normal placeholder:text-vs-muted focus:border-vs-accent"
          />
        </label>

        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-300">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={unlock}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2 text-sm font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60"
          >
            {busy && <SpinnerIcon className="h-4 w-4" />}
            {busy ? "Unlocking…" : "Unlock session"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="rounded-lg border border-vs-border px-4 py-2 text-sm transition hover:bg-vs-hover"
          >
            Start over
          </button>
        </div>
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-vs-editor px-6 text-vs-fg">
      {children}
    </div>
  );
}
