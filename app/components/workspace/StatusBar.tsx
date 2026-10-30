"use client";

import { useState } from "react";
import { humanBytes, humanCount } from "../../lib/format";
import type { ScanResult } from "../../lib/types";
import { GitBranchIcon } from "../icons";
import type { Caret } from "./CodeEditor";
import { languageLabel } from "./EditorArea";

type StatusBarProps = {
  result: ScanResult | null;
  activePath: string | null;
  activeText: string | null;
  caret: Caret;
  /** Null when this session has no repo yet. */
  headSha: string | null;
  saveState: "idle" | "saving" | "saved" | "error";
  /** Whether the event stream is currently connected. */
  live: boolean;
  /** Force the live event stream to tear down and reopen immediately. */
  onReconnect: () => void;
};

export function StatusBar({
  result,
  activePath,
  activeText,
  caret,
  headSha,
  saveState,
  live,
  onReconnect,
}: StatusBarProps) {
  const git = result?.git;
  // Before the first connection the room is connecting, not reconnecting.
  const [connectedOnce, setConnectedOnce] = useState(live);
  if (live && !connectedOnce) setConnectedOnce(true);
  const liveLabel = live ? "Live" : connectedOnce ? "Reconnecting…" : "Connecting…";

  return (
    <footer className="flex h-6 shrink-0 items-center gap-2.5 overflow-hidden whitespace-nowrap border-t border-vs-border bg-vs-chrome px-2.5 text-[10px] text-vs-muted sm:text-[11px]">
      {git?.isGit ? (
        <span className="hidden max-w-64 items-center gap-1 truncate text-vs-fg sm:flex" title={git.commit ?? undefined}>
          <GitBranchIcon className="h-3.5 w-3.5" />
          {git.branch ?? (git.detached ? "detached HEAD" : "unknown")}
        </span>
      ) : (
        <span>{result ? "No source control" : "No folder open"}</span>
      )}

      {headSha && (
        <span className="flex items-center gap-1.5">
          <span
            role="status"
            title={
              live
                ? "Connected — changes from other people appear as they are saved."
                : connectedOnce ? "Reconnecting. Changes made elsewhere will not appear until this recovers."
                : "Connecting to the room’s live updates."
            }
            className="flex items-center gap-1.5"
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full transition-colors ${live ? "bg-vs-success" : connectedOnce ? "bg-vs-warn" : "bg-vs-muted"}`}
            />
            {liveLabel}
          </span>
          {!live && connectedOnce && (
            <button
              type="button"
              onClick={onReconnect}
              title="Reopen the live connection now instead of waiting for the automatic retry."
              className="rounded border border-vs-border px-1.5 py-0.5 text-[11px] leading-none text-vs-fg transition hover:bg-vs-hover"
            >
              Reconnect
            </button>
          )}
        </span>
      )}

      {headSha && (
        <span
          title={
            saveState === "error"
              ? "The last save did not reach the session repository."
              : `Every edit is committed to the session branch. HEAD is ${headSha}.`
          }
          className={
            saveState === "error" ? "text-vs-danger" : "font-mono text-vs-fg"
          }
        >
          {saveState === "saving"
            ? "committing…"
            : saveState === "error"
              ? "not saved"
              : headSha.slice(0, 8)}
        </span>
      )}

      {result && (
        <span className="hidden lg:inline">
          {humanCount(result.stats.files)} files · {humanBytes(result.stats.bytes)}
        </span>
      )}

      <span className="ml-auto flex items-center gap-3">
        {activeText !== null && (
          <>
            <span className="hidden sm:inline">
              Ln {caret.line}, Col {caret.column}
            </span>
            <span className="hidden lg:inline">{indentationOf(activeText)}</span>
            <span className="hidden lg:inline">{activeText.includes("\r\n") ? "CRLF" : "LF"}</span>
            <span className="hidden lg:inline">UTF-8</span>
          </>
        )}
        {activePath && <span className="text-vs-fg">{languageLabel(activePath)}</span>}
      </span>
    </footer>
  );
}

/** Reports the indentation actually used by the buffer, VS Code style. */
function indentationOf(text: string): string {
  const lines = text.split("\n", 400);
  let smallest = 0;

  for (const line of lines) {
    if (line.startsWith("\t")) return "Tab";
    const spaces = line.length - line.trimStart().length;
    if (spaces > 0 && (smallest === 0 || spaces < smallest)) smallest = spaces;
  }

  return smallest > 0 ? `Spaces: ${smallest}` : "Spaces: 2";
}
