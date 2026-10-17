// Chat answers keep what's meant to be copied apart from the prose: code blocks
// are cards with a language header and a copy button, inline code is a pill,
// GitHub-style callouts are tinted cards, and tables get a header row.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../app/components/workspace/Markdown.tsx";

const render = (text) => renderToStaticMarkup(createElement(Markdown, { text }));

test("fenced code is a card with its language and a copy button; inline code is a pill", () => {
  const html = render("Run `npm test` first.\n\n```bash\nnpm install\n```\n\n```ts\nconst a: number = 1;\n```\n\n```\nplain fence\n```\n");
  assert.match(html, /class="md-inline-code[^"]*"[^>]*>npm test<\/code>/);
  assert.equal((html.match(/class="md-code /g) || []).length, 3, "every fence is a code card, with or without a language");
  assert.match(html, />Terminal</, "shell fences read as Terminal");
  assert.match(html, />TypeScript</);
  assert.equal((html.match(/>Copy</g) || []).length, 3, "each card has its own copy button");
  assert.match(html, /text-syn-keyword[^>]*>const</, "code is syntax-coloured");
  assert.doesNotMatch(html, /<pre[^>]*>\s*<pre/, "no nested pre");
});

test("GitHub-style callouts become tinted cards without their marker; plain quotes stay quotes", () => {
  const html = render("> [!WARNING]\n> Back up your data.\n\n> [!tip] Use parallel chats.\n\n> Just a quote.\n");
  assert.match(html, /md-callout md-callout-warning/);
  assert.match(html, />Warning</);
  assert.match(html, /md-callout md-callout-tip/);
  assert.doesNotMatch(html, /\[!/, "the marker is not shown");
  assert.match(html, /<blockquote[^>]*>[\s\S]*Just a quote/);
});

test("tables have a header row; links open safely in a new tab", () => {
  const html = render("| a | b |\n|---|---|\n| 1 | 2 |\n\n[docs](https://example.com)\n");
  assert.match(html, /<thead/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noreferrer"/);
});
