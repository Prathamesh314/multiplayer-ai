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
    <div className="conversation-markdown text-body leading-[1.75] text-vs-fg">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 text-title font-semibold first:mt-0">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-4 text-lead font-semibold first:mt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-3 text-lead font-normal first:mt-0">{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1.5 mt-3 text-body font-normal first:mt-0">{children}</h4>
          ),
          ul: ({ children }) => (
            <ul className="my-2 list-disc space-y-1 pl-5 marker:text-vs-muted">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-vs-muted">{children}</ol>
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
          hr: () => <hr className="my-3 border-vs-border" />,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-vs-border pl-3 text-vs-muted">
              {children}
            </blockquote>
          ),
          code: ({ className, children }) => {
            const content = String(children);
            const isBlock = !!className || content.includes("\n");
            if (isBlock) return <code className={className}>{children}</code>;
            return (
              <code className="rounded border border-vs-border bg-vs-hover px-1 py-0.5 font-mono text-ui text-vs-fg">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="vs-scroll my-2 overflow-x-auto rounded-md border border-vs-border bg-vs-editor p-3 font-mono text-ui leading-5 text-vs-fg">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="vs-scroll my-2 overflow-x-auto">
              <table className="w-full border-collapse text-ui">{children}</table>
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
