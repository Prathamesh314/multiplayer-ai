"use client";

import { useMemo, useState } from "react";
import { TOKEN_CLASS, tokenize } from "../../lib/highlight";
import { languageOf } from "../../lib/language";
import type { Grammar } from "../../lib/language";

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

/** Rows rendered before "Show all", so a huge generated file can't stall the page. */
const PAGE = 1500;

/**
 * A unified diff with old/new line numbers, coloured like the editor when the
 * file's language is known (`path`). Conflict-marker lines a merge left
 * behind are flagged, since a chat cannot merge until they are gone.
 * `bounded` keeps it in its own scroll box; the review page stacks them open.
 */
export function DiffView({ diff, label, path, bounded = true }: { diff: string; label: string; path?: string; bounded?: boolean }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const grammar: Grammar = path ? languageOf(path.split("/").pop() ?? path).grammar : "plain";
  const [all, setAll] = useState(false);
  if (!diff.trim()) return <p className="px-3 py-2 text-xs text-vs-muted">No changes in this file.</p>;
  const shown = all ? lines : lines.slice(0, PAGE);
  return (
    <div role="region" aria-label={label} className={bounded ? "vs-scroll max-h-[50vh] overflow-auto rounded-lg border border-vs-border bg-vs-editor" : "overflow-x-auto bg-vs-editor"}>
      <table className="w-full border-collapse font-mono text-[11.5px] leading-[18px]">
        <tbody>
          {shown.map((line, index) => {
            const marker = line.kind === "add" && /^(?:<{7}|={7}|>{7})(?: |$)/.test(line.text);
            const code = line.kind === "add" || line.kind === "remove" || line.kind === "context";
            return (
              <tr key={index} className={`${ROW[line.kind]} ${marker ? "outline outline-1 -outline-offset-1 outline-vs-warn" : ""}`}>
                <td className={`w-10 select-none px-1.5 text-right align-top text-vs-muted/70 ${line.kind === "remove" ? "bg-vs-danger/10" : ""}`}>{line.old ?? ""}</td>
                <td className={`w-10 select-none px-1.5 text-right align-top text-vs-muted/70 ${line.kind === "add" ? "bg-vs-success/10" : ""}`}>{line.new ?? ""}</td>
                <td className={`w-4 select-none align-top ${line.kind === "add" ? "text-vs-success" : line.kind === "remove" ? "text-vs-danger" : ""}`}>{MARK[line.kind]}</td>
                <td className="whitespace-pre-wrap break-all pr-3 align-top">
                  {code && grammar !== "plain" && line.text
                    ? tokenize(line.text, grammar).map((token, at) => <span key={at} className={TOKEN_CLASS[token.kind]}>{token.text}</span>)
                    : line.text || " "}
                  {marker && <span className="ml-2 font-sans text-[10px] text-vs-warn">conflict marker</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shown.length < lines.length && (
        <button type="button" onClick={() => setAll(true)} className="w-full border-t border-vs-border py-2 text-xs text-vs-accent hover:bg-vs-hover">
          Show all {lines.length.toLocaleString()} lines
        </button>
      )}
    </div>
  );
}
