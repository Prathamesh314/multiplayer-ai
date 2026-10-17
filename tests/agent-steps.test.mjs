// Readable step names in the chat, from the strings the stream parsers record.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeStep } from "../app/lib/ai/steps.ts";

test("agent steps read as plain language, with the target kept as detail", () => {
  assert.deepEqual(describeStep("mcp__claude_ai_Google_Drive__read_file_content"), { label: "Google Drive · Read file content", detail: undefined, kind: "tool" });
  assert.deepEqual(describeStep("ToolSearch"), { label: "Look up tools", detail: undefined, kind: "search" });
  assert.deepEqual(describeStep("Read …app/components/AiPanel.tsx"), { label: "Read", detail: "…app/components/AiPanel.tsx", kind: "read" });
  assert.deepEqual(describeStep("Bash: npm test"), { label: "Run", detail: "npm test", kind: "run" });
  assert.deepEqual(describeStep("WebFetch https://docs.google.com/x"), { label: "Open", detail: "https://docs.google.com/x", kind: "web" });
  assert.deepEqual(describeStep("Grep verifyToken"), { label: "Search code", detail: "verifyToken", kind: "search" });
  // Codex reports shell commands (wrapped in a login shell) and item types.
  assert.deepEqual(describeStep(`/bin/zsh -lc "rg -n session app"`), { label: "Run", detail: "rg -n session app", kind: "run" });
  assert.deepEqual(describeStep("reasoning"), { label: "Thinking", detail: undefined, kind: "think" });
  assert.deepEqual(describeStep("fileChange"), { label: "Edit files", detail: undefined, kind: "write" });
  assert.deepEqual(describeStep("some_new_tool"), { label: "Some new tool", kind: "tool" });
});
