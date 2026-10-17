"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: { hProperties?: Record<string, string> } };
const CALLOUTS = ["note", "tip", "important", "warning", "caution"] as const;
type Callout = (typeof CALLOUTS)[number];
const CALLOUT_LABEL: Record<Callout, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

/**
 * GitHub-style callouts: a blockquote opening with `[!NOTE]`, `[!TIP]`,
 * `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` is marked so it renders as a
 * tinted card, and the marker itself is removed from the text.
 */
function remarkCallouts() {
  const visit = (node: MdNode) => {
    if (node.type === "blockquote") {
      const paragraph = node.children?.[0];
      const first = paragraph?.type === "paragraph" ? paragraph.children?.[0] : undefined;
      const match = first?.type === "text" ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i.exec(first.value ?? "") : null;
      if (match && first) {
        first.value = (first.value ?? "").slice(match[0].length);
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-callout": match[1].toLowerCase() } };
      }
    }
    node.children?.forEach(visit);
  };
  return (tree: MdNode) => visit(tree);
}

/**
 * Agent replies rendered as Markdown, styled to match the workspace. Kept in one
 * place so headings, lists, code, and tables read consistently across the chat.
 * Anything meant to be copied stands apart from the prose: code blocks are
 * raised cards with a copy button, inline code is a tinted pill.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="conversation-markdown text-vs-fg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        components={{
          p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
          // Headings carry the weight here, so a long answer scans. They are
          // sized against the reading surface, not against the toolbar chrome.
          h1: ({ children }) => (
            <h1 className="mb-3 mt-7 text-[1.6em] font-bold leading-tight tracking-tight first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 mt-7 border-b border-vs-border/70 pb-1.5 text-[1.28em] font-bold leading-snug tracking-tight first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-5 text-[1.1em] font-semibold first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-2 mt-4 text-[1em] font-semibold text-vs-fg/90 first:mt-0">{children}</h4>
          ),
          ul: ({ children }) => (
            <ul className="my-3 list-disc space-y-1.5 pl-5 marker:text-vs-accent/70">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 list-decimal space-y-1.5 pl-5 marker:font-medium marker:text-vs-accent/80">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-0.5 [&>ol]:my-1 [&>ul]:my-1">{children}</li>,
          input: ({ checked }) => (
            <input type="checkbox" checked={!!checked} readOnly className="mr-1.5 translate-y-[1px] accent-[var(--vs-accent)]" />
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-vs-accent underline decoration-vs-accent/40 underline-offset-[3px] transition hover:decoration-vs-accent"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-vs-fg">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          hr: () => <hr className="my-6 h-px border-0 bg-gradient-to-r from-transparent via-vs-border to-transparent" />,
          blockquote: ({ children, ...props }) => {
            const kind = (props as Record<string, unknown>)["data-callout"] as Callout | undefined;
            if (kind && CALLOUTS.includes(kind)) {
              return (
                <div className={`md-callout md-callout-${kind} my-4 rounded-xl border px-4 py-3`} role="note">
                  <p className="md-callout-title mb-1 text-[0.82em] font-semibold uppercase tracking-wider">{CALLOUT_LABEL[kind]}</p>
                  <div className="[&>p]:my-1.5">{children}</div>
                </div>
              );
            }
            return (
              <blockquote className="my-4 rounded-r-lg border-l-[3px] border-vs-accent/60 bg-[var(--md-quote-bg)] py-2 pl-4 pr-3 text-vs-fg/85 [&>p]:my-1.5">
                {children}
              </blockquote>
            );
          },
          // Fenced code becomes a CodeBlock (header, language, copy); `pre`
          // only passes it through. Inline code is a warm tinted pill.
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const content = String(children ?? "");
            const language = /language-([\w+#-]+)/.exec(className ?? "")?.[1] ?? "";
            if (className || content.includes("\n")) return <CodeBlock code={content} language={language} />;
            return (
              <code className="md-inline-code rounded-md border border-[var(--md-inline-border)] bg-[var(--md-inline-bg)] px-[0.38em] py-[0.08em] font-mono text-[0.86em] text-[var(--md-inline-fg)]">
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="vs-scroll my-4 overflow-x-auto rounded-xl border border-vs-border">
              <table className="w-full border-collapse text-[0.92em]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-[var(--md-code-head)]">{children}</thead>,
          tr: ({ children }) => <tr className="border-b border-vs-border/70 last:border-0 even:bg-white/[0.02]">{children}</tr>,
          th: ({ children }) => (
            <th className="px-3 py-2 text-left text-[0.92em] font-semibold text-vs-fg">{children}</th>
          ),
          td: ({ children }) => <td className="px-3 py-2 align-top">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
