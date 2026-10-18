"use client";
import { useState } from "react";
import { desktopBridge } from "../../lib/desktop";
import { runnerCommand } from "../../lib/runner/package";

/**
 * The computer connected for AI runs an app from before agents could ask in
 * the chat, so commands and links are refused. Says how to update either way
 * the member runs it; the message goes away once the updated app connects.
 */
export function UpdateComputerHelp() {
  const inDesktop = typeof window !== "undefined" && !!desktopBridge()?.isDesktop;
  const [tab, setTab] = useState<"desktop" | "runner">(inDesktop ? "desktop" : "runner");
  const [copied, setCopied] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const command = runnerCommand(origin, "start");
  const tabClass = (active: boolean) => `rounded-md px-2.5 py-1 text-xs font-medium transition ${active ? "bg-vs-active text-vs-fg" : "text-vs-muted hover:text-vs-fg"}`;
  return (
    <section role="status" aria-label="Update your computer’s app" className="mx-auto mb-2 w-full max-w-4xl rounded-xl border border-vs-warn/40 bg-vs-warn/5 px-4 py-3 text-sm">
      <p className="font-medium text-vs-fg">Update the Multicode AI app on your computer</p>
      <p className="mt-1 leading-6 text-vs-muted">
        It is an older version, so the agent can’t ask you before running a command or opening a link: those are refused. After you update and restart it, this message goes away by itself.
      </p>
      <div role="tablist" aria-label="How you run Multicode AI" className="mt-3 inline-flex gap-1 rounded-lg border border-vs-border p-0.5">
        <button type="button" role="tab" aria-selected={tab === "desktop"} onClick={() => setTab("desktop")} className={tabClass(tab === "desktop")}>Desktop app</button>
        <button type="button" role="tab" aria-selected={tab === "runner"} onClick={() => setTab("runner")} className={tabClass(tab === "runner")}>Runner in a terminal</button>
      </div>
      {tab === "desktop" ? (<>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 leading-6 text-vs-muted">
          <li>Quit Multicode AI completely: <span className="text-vs-fg">Quit</span> from its menu-bar or tray icon (closing the window keeps it running).</li>
          <li><a href="/#download" target="_blank" rel="noopener noreferrer" className="font-medium text-vs-accent underline underline-offset-2">Download the latest Multicode AI</a> for your computer.</li>
          <li>Install it over the old one (on a Mac, drag it to Applications and choose <span className="text-vs-fg">Replace</span>), then open it. It reconnects on its own with your account.</li>
        </ol>
        <p className="mt-2 text-xs leading-5 text-vs-muted">
          Still seeing this after reinstalling? The newest desktop build may not be published yet. Meanwhile, use the runner in a terminal: pause the app’s connection in <span className="text-vs-fg">Desktop settings</span>, then follow <button type="button" onClick={() => setTab("runner")} className="text-vs-accent underline underline-offset-2">Runner in a terminal</button> (connect it once from <span className="text-vs-fg">Your computers</span> if this computer’s runner was never paired).
        </p>
      </>) : (
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 leading-6 text-vs-muted">
          <li>Stop the runner: press <kbd className="rounded border border-vs-border px-1 font-sans text-xs">Ctrl</kbd>+<kbd className="rounded border border-vs-border px-1 font-sans text-xs">C</kbd> in its terminal.</li>
          <li>
            Start the latest version. It keeps this computer’s pairing and worktrees:
            <div className="mt-1.5 flex items-start gap-2 rounded-lg border border-vs-border bg-vs-editor p-2">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-vs-fg">{command}</code>
              <button type="button" aria-label="Copy the runner command" onClick={() => {
                void navigator.clipboard.writeText(command).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
              }} className="shrink-0 rounded-md border border-vs-border px-2 py-0.5 text-xs text-vs-fg hover:bg-vs-hover">{copied ? "Copied" : "Copy"}</button>
            </div>
          </li>
        </ol>
      )}
    </section>
  );
}
