// Tagging repository files with "@" in the AI chat: the composer's matches,
// which tags count when sending, and what the server accepts and tells the agent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanFileRefs, fileRefsFromText, fileRefsPromptBlock, flattenPaths, matchFiles } from "../app/lib/ai/file-mentions.ts";

const tree = { name: "repo", path: "", type: "dir", children: [
  { name: "app", path: "app", type: "dir", children: [
    { name: "lib", path: "app/lib", type: "dir", children: [{ name: "auth.ts", path: "app/lib/auth.ts", type: "file" }, { name: "oauth-client.ts", path: "app/lib/oauth-client.ts", type: "file" }] },
    { name: "page.tsx", path: "app/page.tsx", type: "file" },
  ] },
  { name: "auth.md", path: "docs-auth.md", type: "file" },
  { name: "data.csv", path: "data.csv", type: "file" },
] };
const files = flattenPaths(tree);

test("every file and folder becomes taggable", () => {
  assert.deepEqual(files.map((file) => `${file.path}${file.dir ? "/" : ""}`),
    ["app/", "app/lib/", "app/lib/auth.ts", "app/lib/oauth-client.ts", "app/page.tsx", "docs-auth.md", "data.csv"]);
});

test("folders are offered even when a listing only names files", () => {
  const flat = flattenPaths({ name: "repo", path: "", type: "dir", children: [{ name: "a.csv", path: "data/raw/a.csv", type: "file" }] });
  assert.deepEqual(flat.map((file) => `${file.path}${file.dir ? "/" : ""}`).sort(), ["data/", "data/raw/", "data/raw/a.csv"]);
});

test("matches put names that start with the query first", () => {
  assert.deepEqual(matchFiles(files, "auth").map((file) => file.path), ["app/lib/auth.ts", "docs-auth.md", "app/lib/oauth-client.ts"]);
  assert.deepEqual(matchFiles(files, "app/lib").map((file) => file.path).slice(0, 1), ["app/lib"]);
  assert.deepEqual(matchFiles(files, "").map((file) => file.path), ["app", "docs-auth.md", "data.csv"], "the top level before typing");
  assert.equal(matchFiles(files, "a", 2).length, 2);
});

test("only real paths tagged in the message are sent", () => {
  assert.deepEqual(fileRefsFromText("Compare @app/lib/auth.ts, with @app/lib/ and @missing.ts (and @data.csv).", files), ["app/lib/auth.ts", "app/lib/", "data.csv"]);
  assert.deepEqual(fileRefsFromText("mail me at someone@app/lib/auth.ts", files), [], "@ must start a word");
  assert.deepEqual(fileRefsFromText("@app/page.tsx @app/page.tsx", files), ["app/page.tsx"]);
});

test("the server keeps safe repository paths and tells the agent to read them", () => {
  assert.deepEqual(cleanFileRefs(["app/x.ts", "../etc/passwd", "/abs", "a/./b", "a//b", "dir/", 7, "x\ny", "app/x.ts"]), ["app/x.ts", "dir/"]);
  assert.deepEqual(cleanFileRefs("app/x.ts"), []);
  assert.equal(cleanFileRefs(Array.from({ length: 80 }, (_, i) => `f${i}`)).length, 50);
  assert.equal(fileRefsPromptBlock([]), "");
  assert.match(fileRefsPromptBlock(["app/x.ts", "docs/"]), /<tagged-files>[\s\S]*- app\/x\.ts\n- docs\/\n<\/tagged-files>$/);
});
