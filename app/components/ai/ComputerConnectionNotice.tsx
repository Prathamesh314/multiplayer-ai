"use client";

import { AlertIcon, CheckIcon, ComputerIcon, SpinnerIcon } from "../icons";
import { GhostButton, PrimaryButton } from "../ui/Modal";
import type { ComputerConnection } from "./useComputerConnection";

export function ComputerConnectionNotice({ connection, onConnect, onSetUpAi, compact = false, bar = false }: {
  connection: ComputerConnection;
  onConnect: () => void;
  onSetUpAi: () => void;
  compact?: boolean;
  /** One slim line, for the workspace overview: still a clear button when not connected. */
  bar?: boolean;
}) {
  const { status, computer, error, checking, refresh } = connection;
  const connected = status === "connected";
  const pending = status === "checking";
  const failed = status === "error";
  const title = connected ? "Computer connected" : pending ? "Checking your computer connection…"
    : failed ? "Couldn’t check your computer connection" : status === "offline" ? "Your computer is offline"
    : status === "update" ? "Update your desktop app to use AI" : "Connect your computer to use AI";
  const detail = connected ? `${computer?.name ?? "Your computer"} · Keep the desktop app or computer connection running while AI works.`
    : failed ? error : status === "offline" ? `${computer?.name ?? "Your computer"} is closed, paused or asleep. Open the desktop app on it (or resume it from the app’s menu), or run the start command again in its terminal.`
    : status === "update" ? "This computer is using an older connection. Install the latest desktop app, then sign in again."
    : "AI tasks run on your computer, with your own AI tools. Connect it once to send messages and continue AI chats.";

  if (bar) {
    const short = failed ? "Check your internet connection." : status === "offline" ? "Closed, paused or asleep. Reading and reviewing still work." : status === "update" ? "Install the latest desktop app."
      : "AI runs on your computer. Saved chats stay readable without it.";
    return (
      <section aria-label="Computer connection" data-status={status} className={`mt-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 rounded-xl border px-4 py-2.5 ${connected || pending ? "border-vs-border bg-vs-panel" : "border-vs-accent/40 bg-vs-accent/5"}`}>
        <div className="flex min-w-0 flex-[1_1_18rem] items-center gap-2.5 text-[13px]" role="status" aria-live="polite">
          {pending ? <SpinnerIcon className="h-3.5 w-3.5 shrink-0 text-vs-muted" />
            : <span className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-vs-success" : failed ? "bg-vs-danger" : "bg-vs-warn"}`} />}
          <span className="shrink-0 font-medium text-vs-fg">{title}</span>
          {connected && computer?.name && <span className="min-w-0 truncate font-mono text-[12px] text-vs-muted">{computer.name}</span>}
          {!connected && !pending && <span className="hidden min-w-0 truncate text-[12px] text-vs-muted sm:inline">{short}</span>}
        </div>
        {!pending && <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {failed ? <PrimaryButton disabled={checking} onClick={() => void refresh()}>{checking ? "Checking…" : "Try again"}</PrimaryButton>
            : connected ? <>
              <button type="button" onClick={onConnect} className="rounded-lg border border-vs-border bg-vs-editor px-2.5 py-1 text-[12px] text-vs-fg transition hover:bg-vs-hover">Manage computers</button>
              <button type="button" onClick={onSetUpAi} className="rounded-lg border border-vs-accent/35 bg-vs-editor px-2.5 py-1 text-[12px] text-vs-accent transition hover:bg-vs-accent/10">Set up AI</button>
            </>
            : <PrimaryButton onClick={onConnect}><ComputerIcon className="h-4 w-4" />{status === "offline" ? "Reconnect computer" : status === "update" ? "Update computer" : "Connect computer"}</PrimaryButton>}
        </div>}
      </section>
    );
  }

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
            {!pending && !connected && <p className="mt-1 text-sm leading-5 text-vs-muted">Without it you can still read chats, browse files, review changes and invite teammates.</p>}
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
