"use client";

import { useMemo, useRef } from "react";
import { TOKEN_CLASS, tokenize } from "../../lib/highlight";
import { humanBytes } from "../../lib/format";
import { languageOf } from "../../lib/language";
import { RemoteCarets } from "./RemoteCarets";
import type { FilePresence } from "./usePeople";

/** Above this size the buffer is shown read-only: re-tokenizing gets costly. */
const EDITABLE_LIMIT = 256 * 1024;

export type Caret = { line: number; column: number };

type CodeEditorProps = {
  fileName: string;
  text: string;
  readOnly?: boolean;
  onChange: (text: string) => void;
  onCaretChange: (caret: Caret) => void;
  /** Other people currently in this file, with their caret positions. */
  remote?: FilePresence[];
};

export function CodeEditor({
  fileName,
  text,
  readOnly,
  onChange,
  onCaretChange,
  remote = [],
}: CodeEditorProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { grammar } = languageOf(fileName);
  const tooBig = text.length > EDITABLE_LIMIT;
  const editable = !readOnly && !tooBig;

  const tokens = useMemo(() => tokenize(text, grammar), [text, grammar]);
  const lineCount = useMemo(() => countLines(text), [text]);

  function reportCaret(target: HTMLTextAreaElement) {
    const upToCaret = target.value.slice(0, target.selectionStart);
    const lastBreak = upToCaret.lastIndexOf("\n");
    onCaretChange({
      line: countLines(upToCaret),
      column: upToCaret.length - lastBreak,
    });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab") return;
    // Keep Tab in the editor instead of moving focus, like a real editor.
    event.preventDefault();
    const target = event.currentTarget;
    const { selectionStart, selectionEnd, value } = target;
    const next = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
    onChange(next);
    requestAnimationFrame(() => {
      target.selectionStart = target.selectionEnd = selectionStart + 2;
    });
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-vs-editor">
      {readOnly && (
        <p className="border-b border-vs-border bg-vs-hover px-3 py-1.5 text-sm text-vs-muted">
          Read-only — you have view access to this session.
        </p>
      )}

      {tooBig && !readOnly && (
        <p className="border-b border-vs-border bg-vs-warn/10 px-3 py-1.5 text-sm text-vs-fg">
          {humanBytes(text.length)} of text — opened read-only to keep highlighting responsive.
        </p>
      )}

      <div ref={scrollRef} className="vs-scroll min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full w-max min-w-full font-mono text-[14px] leading-[20px]">
          <div
            aria-hidden
            className="sticky left-0 z-10 shrink-0 select-none bg-vs-editor py-2 pl-4 pr-3 text-right tabular-nums text-vs-gutter"
          >
            {Array.from({ length: lineCount }, (_, index) => (
              <div key={index}>{index + 1}</div>
            ))}
          </div>

          <div className="relative flex-1 py-2 pr-8">
            {/* The highlighted copy sizes the box; the textarea sits on top. */}
            <pre aria-hidden className="whitespace-pre break-normal">
              {tokens.map((token, index) => (
                <span key={index} className={TOKEN_CLASS[token.kind]}>
                  {token.text}
                </span>
              ))}
              {/* Trailing newline needs a line box of its own. */}
              {"\n"}
            </pre>

            <textarea
              value={text}
              readOnly={!editable}
              spellCheck={false}
              wrap="off"
              onChange={(event) => {
                onChange(event.target.value);
                reportCaret(event.target);
              }}
              onKeyDown={onKeyDown}
              onKeyUp={(event) => reportCaret(event.currentTarget)}
              onClick={(event) => reportCaret(event.currentTarget)}
              onSelect={(event) => reportCaret(event.currentTarget)}
              className="absolute inset-0 resize-none overflow-hidden whitespace-pre border-0 bg-transparent px-0 py-2 pr-8 font-mono text-[14px] leading-[20px] text-transparent caret-vs-fg outline-none selection:bg-vs-accent/30"
            />

            <RemoteCarets people={remote} />
          </div>
        </div>
      </div>
    </div>
  );
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lines += 1;
  }
  return lines;
}
