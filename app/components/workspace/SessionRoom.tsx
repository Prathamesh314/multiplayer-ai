"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { joinSession, loadSession } from "../../lib/session/client";
import {
  clearShareCode,
  readShareCode,
  stashShareCode,
  takeStashedShareCode,
} from "../../lib/session/share";
import type { Session } from "../../lib/session/types";
import { AlertIcon, SparkleIcon, SpinnerIcon } from "../icons";
import { Workspace } from "./Workspace";

type RoomState =
  | { kind: "loading"; label: string }
  | { kind: "ready"; session: Session }
  | { kind: "locked"; reason: string }
  | { kind: "error"; message: string };

export function SessionRoom({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [state, setState] = useState<RoomState>({ kind: "loading", label: "Opening session…" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      // Read before anything awaits: a share link is only in the URL until it
      // is redeemed, and this must not race with `clearShareCode`.
      // A code stashed before a trip through sign-in counts too.
      const shared = readShareCode() ?? takeStashedShareCode(sessionId);

      try {
        const result = await loadSession(sessionId);
        if (cancelled) return;

        if (result.state === "signin") {
          // Carry the code across sign-in, or following a share link while
          // signed out would land on a locked screen asking for the code the
          // link already contained.
          if (shared) stashShareCode(sessionId, shared);
          router.replace(`/login?next=${encodeURIComponent(`/s/${sessionId}`)}`);
          return;
        }

        if (result.state === "ready") {
          // Already a member; the code in the URL is redundant.
          if (shared) clearShareCode();
          setState({ kind: "ready", session: result.session });
          return;
        }

        // A share link means this browser can admit itself without the code
        // being typed in — that is the whole point of the link.
        if (shared) {
          setState({ kind: "loading", label: "Opening shared session…" });
          try {
            const session = await joinSession(sessionId, shared);
            if (cancelled) return;
            clearShareCode();
            setState({ kind: "ready", session });
            return;
          } catch {
            // A stale or tampered link falls through to the locked screen
            // rather than reporting a different failure.
          }
        }

        if (!cancelled) setState({ kind: "locked", reason: result.reason });
      } catch (cause) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : "Could not open this session.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, router]);

  if (state.kind === "ready") {
    return (
      <Workspace
        session={state.session}
        onAccessLost={(reason) =>
          setState({ kind: "locked", reason: reason ?? "Your access to this room has changed." })
        }
      />
    );
  }

  if (state.kind === "loading") {
    return (
      <Centered>
        <SpinnerIcon className="h-6 w-6 text-vs-accent" />
        <p className="text-base text-vs-muted">{state.label}</p>
      </Centered>
    );
  }

  if (state.kind === "error") {
    return (
      <Centered>
        <AlertIcon className="h-6 w-6 text-vs-warn" />
        <p className="max-w-sm text-center text-base text-vs-muted">{state.message}</p>
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
      <div className="w-full max-w-md rounded-2xl border border-vs-border bg-vs-panel p-6 shadow-xl sm:p-8">
        <span className="flex items-center gap-2 text-base font-semibold">
          <SparkleIcon className="h-4 w-4 text-vs-accent" />
          <span className="whitespace-nowrap">
            multiplayer<span className="text-vs-muted">-ai</span>
          </span>
        </span>

        <h1 className="font-display mt-4 text-xl font-semibold tracking-tight">
          This session is locked
        </h1>
        <p className="mt-1.5 text-[14px] leading-6 text-vs-muted">{reason}</p>

        <p className="mt-4 font-mono text-[12px] text-vs-muted">/s/{sessionId}</p>

        <label className="mt-4 block text-sm font-medium uppercase tracking-wide text-vs-muted">
          Access code
          <input
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) void unlock();
            }}
            placeholder="A1B2-C3D4"
            className="mt-1.5 w-full rounded-lg border border-vs-border bg-vs-editor px-3 py-2 font-mono text-base font-normal tracking-[0.12em] text-vs-fg outline-none placeholder:tracking-normal placeholder:text-vs-muted focus:border-vs-accent"
          />
        </label>

        {error && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-vs-danger/40 bg-vs-danger/10 px-3 py-2 text-sm leading-5 text-vs-danger">
            <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={unlock}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-vs-accent px-4 py-2 text-base font-medium text-vs-accent-fg transition hover:opacity-90 disabled:opacity-60"
          >
            {busy && <SpinnerIcon className="h-4 w-4" />}
            {busy ? "Unlocking…" : "Unlock session"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/workspace")}
            className="rounded-lg border border-vs-border px-4 py-2 text-base transition hover:bg-vs-hover"
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
    <div className="app-page flex h-dvh flex-col items-center justify-center gap-3 bg-vs-editor px-6 text-vs-fg">
      {children}
    </div>
  );
}
