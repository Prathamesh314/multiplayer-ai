"use client";

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
};

export function StatusBar({ result, activePath, activeText, caret }: StatusBarProps) {
  const git = result?.git;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-vs-border bg-vs-chrome px-3 text-[11px] text-vs-muted">
      {git?.isGit ? (
        <span className="flex items-center gap-1 text-vs-fg" title={git.commit ?? undefined}>
          <GitBranchIcon className="h-3.5 w-3.5" />
          {git.branch ?? (git.detached ? "detached HEAD" : "unknown")}
        </span>
      ) : (
        <span>{result ? "No source control" : "No folder open"}</span>
      )}

      {result && (
        <span>
          {humanCount(result.stats.files)} files · {humanBytes(result.stats.bytes)}
        </span>
      )}

      <span className="ml-auto flex items-center gap-3">
        {activeText !== null && (
          <>
            <span>
              Ln {caret.line}, Col {caret.column}
            </span>
            <span>{indentationOf(activeText)}</span>
            <span>{activeText.includes("\r\n") ? "CRLF" : "LF"}</span>
            <span>UTF-8</span>
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
