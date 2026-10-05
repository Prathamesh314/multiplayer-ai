"use client";

import { AlertIcon, CheckIcon, ComputerIcon, SpinnerIcon } from "../icons";
import { GhostButton, PrimaryButton } from "../ui/Modal";
import type { ComputerConnection } from "./useComputerConnection";

export function ComputerConnectionNotice({ connection, onConnect, onSetUpAi, compact = false }: {
  connection: ComputerConnection;
  onConnect: () => void;
  onSetUpAi: () => void;
  compact?: boolean;
}) {
  const { status, computer, error, checking, refresh } = connection;
  if (status === "server") return null;
  const connected = status === "connected";
  const pending = status === "checking";
  const failed = status === "error";
  const title = connected ? "Computer connected" : pending ? "Checking your computer connection…"
    : failed ? "Couldn’t check your computer connection" : status === "offline" ? "Your computer is offline"
    : status === "update" ? "Update your desktop app to use AI" : "Connect your computer to use AI";
  const detail = connected ? `${computer?.name ?? "Your computer"} · Keep the desktop app or computer connection running while AI works.`
    : failed ? error : status === "offline" ? "Open the desktop app and sign in with this account. If the connection is paused, resume it from the desktop menu."
    : status === "update" ? "This computer is using an older connection. Install the latest desktop app, then sign in again."
    : "AI tasks run on your computer. Connect it once to send messages and continue AI chats.";

  return (
    <section aria-label="Computer connection" data-status={status} className={`shrink-0 border-vs-border bg-vs-panel ${compact ? "border-b px-4 py-2.5" : "mt-6 rounded-xl border p-4 sm:p-5"}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-3">
          <span className={`mt-0.5 shrink-0 ${connected ? "text-vs-success" : failed ? "text-vs-warn" : "text-vs-accent"}`}>
            {pending ? <SpinnerIcon className="h-5 w-5" /> : connected ? <CheckIcon className="h-5 w-5" /> : failed ? <AlertIcon className="h-5 w-5" /> : <ComputerIcon className="h-5 w-5" />}
          </span>
          <div className="min-w-0" role="status" aria-live="polite">
            <p className="text-sm font-semibold sm:text-base">{title}</p>
            {!pending && <p className="mt-1 break-words text-sm leading-5 text-vs-muted">{detail}</p>}
            {!pending && !connected && <p className="mt-1 text-sm leading-5 text-vs-muted">You can still open saved chats and browse files.</p>}
          </div>
        </div>
        {!pending && <div className="flex shrink-0 flex-wrap items-center gap-2">
          {failed ? <PrimaryButton disabled={checking} onClick={() => void refresh()}>{checking ? "Checking…" : "Try again"}</PrimaryButton>
            : connected ? <><GhostButton onClick={onConnect}>Manage computers</GhostButton>{!compact && <GhostButton onClick={onSetUpAi}>Set up AI</GhostButton>}</>
            : <PrimaryButton onClick={onConnect}><ComputerIcon className="h-4 w-4" />{status === "offline" ? "Reconnect computer" : status === "update" ? "Update computer" : "Connect computer"}</PrimaryButton>}
        </div>}
      </div>
    </section>
  );
}
