// The composer remembers the member's agent, model and effort on this device,
// so a reload keeps Claude Code selected instead of falling back to Codex.
import assert from "node:assert/strict";
import { test } from "node:test";

const store = new Map();
globalThis.window = { localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) } };
const { agentForChat, preferredAgent, rememberChoice, savedPicks } = await import("../app/lib/ai/composer-choice.ts");

const agents = [
  { id: "codex", installed: true, models: { choices: [{ id: "", label: "Auto" }] } },
  { id: "claude", installed: true, models: { choices: [{ id: "", label: "Auto" }, { id: "opus", label: "Opus", efforts: [{ id: "high", label: "High" }] }] } },
  { id: "gemini", installed: false },
];

test("a reload keeps the agent and its model the member chose", () => {
  assert.equal(preferredAgent(agents), "codex", "Codex by default");
  rememberChoice("claude", "opus", "high");
  assert.equal(preferredAgent(agents), "claude");
  assert.deepEqual(savedPicks(agents[1]), { model: "opus", effort: "high" });
  assert.deepEqual(savedPicks(agents[0]), { model: "", effort: "" }, "each agent keeps its own picks");
});

test("a choice that is no longer available falls back safely", () => {
  rememberChoice("gemini", "", "");
  assert.equal(preferredAgent(agents), "codex", "not installed any more");
  rememberChoice("claude", "retired-model", "high");
  assert.deepEqual(savedPicks(agents[1]), { model: "", effort: "" });
  rememberChoice("claude", "opus", "turbo");
  assert.deepEqual(savedPicks(agents[1]), { model: "opus", effort: "" });
  store.set("multicode.composer.v1", "{ broken");
  assert.equal(preferredAgent(agents), "codex", "damaged storage is ignored");
  globalThis.window.localStorage.getItem = () => { throw new Error("blocked"); };
  assert.equal(preferredAgent(agents), "codex", "blocked storage is ignored");
  assert.doesNotThrow(() => rememberChoice("claude", "", ""));
});

test("an opened chat starts with the agent that ran it, without changing the default for new chats", () => {
  store.clear();
  globalThis.window.localStorage.getItem = (key) => store.get(key) ?? null;
  rememberChoice("codex", "", "");
  assert.equal(agentForChat(agents, "claude"), "claude", "a Claude chat continues with Claude");
  assert.equal(agentForChat(agents, "gemini"), "codex", "not set up here: the usual agent");
  assert.equal(agentForChat(agents, null), "codex", "a new chat uses the usual agent");
  rememberChoice("claude", "opus", "high", false);
  assert.equal(preferredAgent(agents), "codex", "following a chat keeps the default");
  assert.deepEqual(savedPicks(agents[1]), { model: "opus", effort: "high" }, "but its model and effort are kept");
});
