"use client";

import { useMemo } from "react";

type DiffLine = { kind: "add" | "remove" | "context" | "hunk" | "meta"; text: string; old: number | null; new: number | null };

/** Parse a unified diff into lines numbered from its hunk headers. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const text of diff.replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text, old: null, new: null });
    } else if (!inHunk || text.startsWith("diff --git ")) {
      inHunk = false;
      // Git's own file header repeats what the file list already shows; keep
      // anything else it says, such as "Binary files … differ".
      if (!/^(?:diff --git |index |--- |\+\+\+ |(?:new|deleted) file mode |old mode |new mode )/.test(text)) {
        lines.push({ kind: "meta", text, old: null, new: null });
      }
    } else if (text.startsWith("+")) {
      lines.push({ kind: "add", text: text.slice(1), old: null, new: newLine++ });
    } else if (text.startsWith("-")) {
      lines.push({ kind: "remove", text: text.slice(1), old: oldLine++, new: null });
    } else if (text.startsWith("\\")) {
      lines.push({ kind: "meta", text, old: null, new: null });
    } else {
      lines.push({ kind: "context", text: text.slice(1), old: oldLine++, new: newLine++ });
    }
  }
  return lines;
}

const ROW: Record<DiffLine["kind"], string> = {
  add: "bg-vs-success/10",
  remove: "bg-vs-danger/10",
  context: "",
  hunk: "bg-vs-accent/5 text-vs-muted",
  meta: "text-vs-muted",
};
const MARK: Record<DiffLine["kind"], string> = { add: "+", remove: "−", context: " ", hunk: "", meta: "" };

/**
 * A unified diff with old/new line numbers. Conflict-marker lines a merge
 * left behind are flagged, since a chat cannot merge until they are gone.
 */
export function DiffView({ diff, label }: { diff: string; label: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  if (!diff.trim()) return <p className="px-3 py-2 text-xs text-vs-muted">No changes in this file.</p>;
  return (
    <div role="region" aria-label={label} className="vs-scroll max-h-[50vh] overflow-auto rounded-lg border border-vs-border bg-vs-editor">
      <table className="w-full border-collapse font-mono text-[11.5px] leading-[18px]">
        <tbody>
          {lines.map((line, index) => {
            const marker = line.kind === "add" && /^(?:<{7}|={7}|>{7})(?: |$)/.test(line.text);
            return (
              <tr key={index} className={`${ROW[line.kind]} ${marker ? "outline outline-1 -outline-offset-1 outline-vs-warn" : ""}`}>
                <td className="w-10 select-none px-1.5 text-right align-top text-vs-muted/70">{line.old ?? ""}</td>
                <td className="w-10 select-none px-1.5 text-right align-top text-vs-muted/70">{line.new ?? ""}</td>
                <td className={`w-4 select-none align-top ${line.kind === "add" ? "text-vs-success" : line.kind === "remove" ? "text-vs-danger" : ""}`}>{MARK[line.kind]}</td>
                <td className="whitespace-pre-wrap break-all pr-3 align-top">
                  {line.text || " "}
                  {marker && <span className="ml-2 font-sans text-[10px] text-vs-warn">conflict marker</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
