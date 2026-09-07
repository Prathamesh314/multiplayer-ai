"use client";

import { useRef, useState } from "react";
import { CheckIcon, FilesIcon } from "../icons";

export function Avatar({ name }: { name: string }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-vs-accent/12 text-[10px] font-semibold uppercase text-vs-accent">
      {initials(name)}
    </span>
  );
}

/**
 * A read-only link with a copy button. The field is selectable so a copy is
 * always possible by hand, and the button falls back to selecting the text if
 * the async clipboard API is unavailable (older browsers, insecure contexts).
 */
export function CopyLink({ url }: { url: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      inputRef.current?.select();
      try {
        document.execCommand("copy");
      } catch {
        // Nothing else to try; the text is selected for a manual copy.
        return;
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        ref={inputRef}
        readOnly
        value={url}
        onFocus={(e) => e.target.select()}
        className="min-w-0 flex-1 rounded border border-vs-border bg-vs-panel px-2 py-1.5 font-mono text-[11px] text-vs-fg outline-none"
      />
      <button
        type="button"
        onClick={copy}
        className={`flex shrink-0 items-center gap-1 rounded border px-2 py-1.5 text-[11px] font-medium transition ${
          copied
            ? "border-vs-success/50 text-vs-success"
            : "border-vs-border text-vs-muted hover:bg-vs-hover hover:text-vs-fg"
        }`}
      >
        {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <FilesIcon className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}
