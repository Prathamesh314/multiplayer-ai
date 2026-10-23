"use client";

/*
 * In the desktop app: "New update available" once the website's newer release
 * is downloaded and verified (desktop/site-update.js). Restart installs it and
 * reopens the app; See changes lists what changed. Closing it hides it until
 * the app next starts. Renders nothing in a browser or an older app.
 */

import { useEffect, useState } from "react";
import { desktopBridge, type DesktopUpdate } from "../lib/desktop";
import { CloseIcon } from "./icons";

const DISMISSED = "multicode:update-dismissed";

function dismissed(build: string | null): boolean {
  try { return !!build && window.sessionStorage.getItem(DISMISSED) === build; } catch { return false; }
}

export function DesktopUpdateNotice() {
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.onUpdate || !bridge.updateState) return;
    const show = (state: DesktopUpdate) => { setUpdate(state); setHidden(dismissed(state.build)); };
    void bridge.updateState().then(show).catch(() => {});
    return bridge.onUpdate(show);
  }, []);

  if (!update || update.status !== "ready" || hidden) return null;

  async function restart() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await desktopBridge()?.installUpdate?.();
      if (!result?.ok) setMessage(result?.error ?? "Could not install the update. Try again.");
      else if (result.opened === "download") setMessage("This copy can’t update itself. The download page is open in your browser.");
    } catch {
      setMessage("Could not install the update. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    try { if (update?.build) window.sessionStorage.setItem(DISMISSED, update.build); } catch { /* shown again on the next page */ }
    setHidden(true);
  }

  return (
    <section role="status" aria-label="Desktop update" className="fixed bottom-10 left-5 z-50 w-[min(22rem,calc(100vw-2.5rem))] rounded-2xl border border-vs-border bg-[#0b0a09] p-5 text-vs-fg shadow-[0_18px_48px_rgb(0_0_0_/_0.55)]">
      <button type="button" onClick={close} aria-label="Close update notice"
        className="absolute -left-2.5 -top-2.5 flex h-7 w-7 items-center justify-center rounded-full border border-vs-border bg-[#0b0a09] text-vs-muted transition hover:text-vs-fg">
        <CloseIcon className="h-3 w-3" />
      </button>
      <p className="text-[15px] font-medium">New update available</p>
      {message && <p role="alert" className="mt-2 text-[12.5px] leading-5 text-vs-muted">{message}</p>}
      <div className="mt-4 flex gap-2.5">
        {update.changes && (
          <button type="button" onClick={() => void desktopBridge()?.showUpdateChanges?.()}
            className="rounded-lg border border-vs-border bg-vs-panel px-4 py-2 text-[13.5px] transition hover:bg-vs-active">
            See changes
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => void restart()}
          className="rounded-lg bg-vs-fg px-4 py-2 text-[13.5px] font-medium text-vs-editor transition hover:opacity-90 disabled:opacity-60">
          {busy ? "Restarting…" : "Restart"}
        </button>
      </div>
    </section>
  );
}
