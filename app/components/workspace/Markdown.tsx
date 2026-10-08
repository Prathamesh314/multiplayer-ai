"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Agent replies rendered as Markdown, styled to match the workspace. Kept in one
 * place so headings, lists, code, and tables read consistently across the chat.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="conversation-markdown text-vs-fg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
          // Headings carry the weight here, so a long answer scans. They are
          // sized against the reading surface, not against the toolbar chrome.
          h1: ({ children }) => (
            <h1 className="mb-3 mt-7 text-[1.72em] font-bold leading-tight tracking-tight first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-3 mt-7 text-[1.32em] font-bold leading-snug tracking-tight first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-5 text-[1.1em] font-semibold first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-2 mt-4 text-[1em] font-semibold first:mt-0">{children}</h4>
          ),
          ul: ({ children }) => (
            <ul className="my-3 list-disc space-y-1.5 pl-5 marker:text-vs-muted">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-3 list-decimal space-y-1.5 pl-5 marker:text-vs-muted">{children}</ol>
          ),
          li: ({ children }) => <li className="[&>ul]:my-1 [&>ol]:my-1">{children}</li>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-vs-accent underline-offset-2 hover:underline"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-vs-fg">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          hr: () => <hr className="my-5 border-vs-border" />,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-vs-border pl-4 text-vs-muted">
              {children}
            </blockquote>
          ),
          // Inline code reads as a pill set into the prose: relative size so it
          // tracks the surrounding text, and a filled ground rather than an
          // outline, which at this size looked like a stray box.
          code: ({ className, children }) => {
            const content = String(children);
            const isBlock = !!className || content.includes("\n");
            if (isBlock) return <code className={className}>{children}</code>;
            return (
              <code className="rounded-md bg-vs-hover px-[0.4em] py-[0.15em] font-mono text-[0.88em] text-vs-fg">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="vs-scroll my-4 overflow-x-auto rounded-lg bg-vs-editor p-4 font-mono text-[0.86em] leading-[1.6] text-vs-fg">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="vs-scroll my-4 overflow-x-auto">
              <table className="w-full border-collapse text-[0.92em]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-vs-border px-2 py-1 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => <td className="border border-vs-border px-2 py-1">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
