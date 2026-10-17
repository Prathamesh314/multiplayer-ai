"use client";

import { useEffect, useMemo, useState } from "react";
import { TOKEN_CLASS, tokenize } from "../../lib/highlight";
import { languageOf } from "../../lib/language";
import { CheckIcon, FilesIcon, TerminalIcon } from "../icons";

/** Fence names agents use, mapped to the file extensions the highlighter knows. */
const ALIASES: Record<string, string> = {
  typescript: "ts", javascript: "js", python: "py", ruby: "rb", rust: "rs", golang: "go",
  shell: "sh", bash: "sh", zsh: "sh", console: "sh", terminal: "sh", shellscript: "sh",
  yml: "yaml", markdown: "md", text: "txt", plaintext: "txt", "c++": "cpp", csharp: "cs",
};
const SHELL = new Set(["sh", "ps1", "bat", "fish"]);

/**
 * A fenced code block in an answer: a raised card, apart from the prose, with
 * its language and a copy button in a header, and the familiar syntax colours.
 * Copying takes the code exactly as written (no prompt markers added).
 */
export function CodeBlock({ code, language }: { code: string; language: string }) {
  const fence = language.toLowerCase();
  const extension = ALIASES[fence] ?? fence;
  const spec = languageOf(`snippet.${extension || "txt"}`);
  const shell = SHELL.has(extension);
  const label = fence ? (shell ? "Terminal" : spec.label === "Plain Text" ? fence : spec.label) : "Code";
  const tokens = useMemo(() => tokenize(code, spec.grammar), [code, spec.grammar]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="md-code group/code my-4 overflow-hidden rounded-xl border border-[var(--md-code-border)] bg-[var(--md-code-bg)] shadow-[0_1px_0_rgb(255_255_255/0.03)_inset]">
      <div className="flex items-center gap-2 border-b border-[var(--md-code-border)] bg-[var(--md-code-head)] px-3 py-1.5 text-[11.5px] text-vs-muted">
        {shell && <TerminalIcon className="h-3.5 w-3.5" />}
        <span className="font-medium">{label}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code.replace(/\n$/, "")).then(() => setCopied(true), () => {});
          }}
          aria-label={copied ? "Copied" : `Copy ${label.toLowerCase()} code`}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-vs-muted transition hover:bg-white/5 hover:text-vs-fg"
        >
          {copied ? <CheckIcon className="h-3.5 w-3.5 text-vs-success" /> : <FilesIcon className="h-3.5 w-3.5" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="vs-scroll overflow-x-auto px-4 py-3.5 font-mono text-[13px] leading-[1.65]">
        <code>
          {tokens.map((token, index) => (
            <span key={index} className={TOKEN_CLASS[token.kind]}>{token.text}</span>
          ))}
        </code>
      </pre>
    </div>
  );
}
