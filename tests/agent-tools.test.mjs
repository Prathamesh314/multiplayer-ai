// MCP servers and plugins configured in the app: definitions are validated and
// never hold secrets, project tools run for a member only once they allowed
// that exact definition, and the runner applies them per run (a private
// --mcp-config file for Claude Code, thread config for Codex) with keys from
// this computer only.
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import {
  fillSecrets, joinCommand, normaliseSpec, parseVars, secretNames, splitCommand, toolName, TOOL_PRESETS,
} from "../app/lib/ai/agent-tools-spec.ts";
import {
  approveTool, createTool, deleteTool, listPersonalTools, listProjectTools, pendingToolCount, revokeTool, toolsForRun, updateTool,
} from "../app/lib/ai/agent-tools.ts";
import { prepareTools, readSecrets, secretNamesHere, writeSecret } from "../runner/agent-tools.ts";
import { runAgentLocally } from "../runner/execute.ts";
import { agentById } from "../app/lib/ai/catalog.ts";
import { codexApprovalResult, describeCodexApproval } from "../runner/codex-session.ts";

const playwright = { kind: "mcp", name: "playwright", spec: { transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], env: [] } };
const github = { kind: "mcp", name: "github", spec: { transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: [{ name: "Authorization", value: "Bearer ${GITHUB_TOKEN}" }] } };

test("definitions are validated, and keys are referred to by name only", () => {
  assert.equal(toolName(" Playwright "), "playwright");
  assert.throws(() => toolName("my tool"), /lowercase/);
  assert.deepEqual(normaliseSpec("mcp", { ...playwright.spec, command: " npx " }).spec.command, "npx");
  assert.throws(() => normaliseSpec("mcp", { transport: "http", url: "http://example.com/mcp" }), /https/);
  assert.equal(normaliseSpec("mcp", { transport: "http", url: "http://localhost:3845/mcp" }).spec.url, "http://localhost:3845/mcp");
  assert.throws(() => normaliseSpec("mcp", { transport: "http", url: "https://user:pw@example.com/mcp" }), /secret/);
  assert.throws(() => normaliseSpec("mcp", { transport: "stdio", command: "x", args: ["a\nb"] }), /Argument 1/);
  assert.throws(() => normaliseSpec("mcp", { transport: "stdio", command: "x", env: [{ name: "A", value: "1" }, { name: "a", value: "2" }] }), /twice/);
  assert.throws(() => normaliseSpec("plugin", { source: "git", url: "https://github.com/a/b", path: "../etc" }), /inside the repository/);
  assert.throws(() => normaliseSpec("plugin", { source: "git", url: "https://github.com/a/b", ref: "main; rm" }), /unusual/);
  assert.throws(() => normaliseSpec("tool", {}), /MCP server or a plugin/);
  assert.deepEqual(secretNames(github.spec), ["GITHUB_TOKEN"]);
  assert.deepEqual(secretNames({ transport: "stdio", command: "npx", args: ["${DATABASE_URL}", "${lower}"], env: [{ name: "K", value: "${API_KEY}" }] }), ["API_KEY", "DATABASE_URL"]);
  const missing = new Set();
  assert.equal(fillSecrets("Bearer ${A} ${B}", (name) => (name === "A" ? "x" : undefined), missing), "Bearer x ${B}");
  assert.deepEqual([...missing], ["B"]);
  for (const preset of TOOL_PRESETS) assert.doesNotThrow(() => normaliseSpec(preset.kind, preset.spec), preset.id);
});

test("commands and variables are edited as plain text", () => {
  assert.deepEqual(splitCommand(`npx -y "@scope/pkg" --title 'two words'`), ["npx", "-y", "@scope/pkg", "--title", "two words"]);
  assert.deepEqual(splitCommand(joinCommand(["node", "server with space.js", ""])), ["node", "server with space.js", ""]);
  assert.throws(() => splitCommand(`npx "open`), /quote/);
  assert.deepEqual(parseVars("A=1\n\n B = x=y \n", "="), [{ name: "A", value: "1" }, { name: "B", value: "x=y" }]);
  assert.deepEqual(parseVars("Authorization: Bearer ${T}", ":"), [{ name: "Authorization", value: "Bearer ${T}" }]);
  assert.throws(() => parseVars("novalue", "="), /NAME=value/);
});

test("project tools run for a member only after they allow that exact definition", async () => {
  const f = await memoryFixture();
  try {
    const id = await createTool({ projectId: f.project }, f.alice, playwright);
    await assert.rejects(createTool({ projectId: f.project }, f.alice, playwright), /already exists/);
    assert.equal((await listProjectTools(f.project, f.alice))[0].approved, true, "whoever adds it has seen it");
    assert.equal((await listProjectTools(f.project, f.bob))[0].approved, false);
    assert.equal(await pendingToolCount(f.project, f.bob), 1);
    assert.deepEqual(await toolsForRun(f.project, f.bob), [], "not allowed yet");

    await approveTool(id, f.bob);
    assert.deepEqual((await toolsForRun(f.project, f.bob)).map((tool) => tool.name), ["playwright"]);
    assert.equal(await pendingToolCount(f.project, f.bob), 0);

    // A manager changes what it runs: Bob is asked again, Alice (the editor) is not.
    await updateTool({ projectId: f.project }, id, f.alice, { ...playwright, spec: { ...playwright.spec, args: ["-y", "evil-package"] } });
    assert.deepEqual(await toolsForRun(f.project, f.bob), [], "a changed definition needs approving again");
    assert.equal((await toolsForRun(f.project, f.alice)).length, 1);
    await approveTool(id, f.bob);
    await updateTool({ projectId: f.project }, id, f.alice, { enabled: false });
    assert.deepEqual(await toolsForRun(f.project, f.bob), [], "turned off for everyone");
    assert.equal((await listProjectTools(f.project, f.bob))[0].approved, true, "turning off and on is not a new definition");
    await updateTool({ projectId: f.project }, id, f.alice, { enabled: true });
    await revokeTool(id, f.bob);
    assert.deepEqual(await toolsForRun(f.project, f.bob), []);

    // Personal tools apply to every chat their owner drives, and win a name clash.
    await approveTool(id, f.bob);
    const own = await createTool({ ownerId: f.bob }, f.bob, { ...playwright, spec: { ...playwright.spec, args: ["-y", "@playwright/mcp@1.0.0"] } });
    await createTool({ ownerId: f.bob }, f.bob, github);
    const bobs = await toolsForRun(f.project, f.bob);
    assert.deepEqual(bobs.map((tool) => [tool.name, tool.id === own]), [["github", false], ["playwright", true]]);
    assert.deepEqual((await toolsForRun(null, f.bob)).map((tool) => tool.name), ["github", "playwright"], "also in chats outside a project");
    assert.deepEqual(await toolsForRun(f.project, f.outsider), []);
    assert.deepEqual((await listPersonalTools(f.bob)).map((tool) => [tool.name, tool.approved, tool.secrets]), [["github", true, ["GITHUB_TOKEN"]], ["playwright", true, []]]);
    assert.deepEqual(await listPersonalTools(f.alice), [], "personal tools are private");

    // Scopes cannot reach each other's tools; ids are checked before the database sees them.
    await assert.rejects(deleteTool({ ownerId: f.alice }, own), /not found/);
    await assert.rejects(updateTool({ projectId: f.project }, own, f.alice, { enabled: false }), /not found/);
    await assert.rejects(approveTool(own, f.alice), /not found/, "personal tools have no approvals");
    await assert.rejects(deleteTool({ ownerId: f.bob }, "not-a-uuid"), /not found/);
    await deleteTool({ projectId: f.project }, id);
    assert.deepEqual(await listProjectTools(f.project, f.alice), []);
  } finally {
    await f.close();
  }
});

test("keys stay in this computer's data folder, readable by its user only", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "tool-secrets-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.deepEqual(readSecrets(dataDir), {});
  writeSecret(dataDir, "GITHUB_TOKEN", "ghp_1");
  writeSecret(dataDir, "DATABASE_URL", "postgres://x");
  assert.deepEqual(secretNamesHere(dataDir), ["DATABASE_URL", "GITHUB_TOKEN"]);
  if (process.platform !== "win32") assert.equal(statSync(join(dataDir, "secrets.json")).mode & 0o777, 0o600);
  writeSecret(dataDir, "DATABASE_URL", null);
  assert.deepEqual(readSecrets(dataDir), { GITHUB_TOKEN: "ghp_1" });
  assert.throws(() => writeSecret(dataDir, "lower", "x"), /capital/);
  assert.throws(() => writeSecret(dataDir, "EMPTY", ""), /empty/);
  await writeFile(join(dataDir, "secrets.json"), "{ damaged");
  assert.deepEqual(readSecrets(dataDir), {}, "a damaged file does not fail every run");
});

test("the runner hands tools to each agent its own way, leaving out what cannot run", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "tool-prepare-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const tools = [
    { id: "1", hash: "h", ...playwright },
    { id: "2", hash: "h", ...github },
    { id: "3", hash: "h", kind: "plugin", name: "review", spec: { source: "zip", url: "https://example.com/review.zip" } },
  ];
  const before = await prepareTools(tools, "claude", dataDir);
  assert.match(before.notices.join("\n"), /github left out: add GITHUB_TOKEN on this computer/);
  writeSecret(dataDir, "GITHUB_TOKEN", "ghp_secret");

  const claude = await prepareTools(tools, "claude", dataDir);
  const file = claude.args[claude.args.indexOf("--mcp-config") + 1];
  assert.equal(claude.args[0], "--mcp-config", "before the prompt flags");
  assert.deepEqual(claude.args.slice(2), ["--plugin-url", "https://example.com/review.zip"]);
  assert.doesNotMatch(claude.args.join(" "), /ghp_secret/, "keys never go on the command line");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { mcpServers: {
    playwright: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], env: {} },
    github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ghp_secret" } },
  } });
  assert.equal(claude.notices[0], "AI tools for this chat: playwright, github, review");
  await claude.cleanup();
  assert.equal(existsSync(file), false, "the file is removed after the run");

  const codex = await prepareTools(tools, "codex", dataDir);
  assert.deepEqual(codex.args, []);
  assert.deepEqual(codex.codexConfig, { mcp_servers: {
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"], env: {} },
    github: { url: "https://api.githubcopilot.com/mcp/", http_headers: { Authorization: "Bearer ghp_secret" } },
  } });
  assert.match(codex.notices.join("\n"), /review left out: plugins work with Claude Code/);

  const gemini = await prepareTools(tools, "gemini", dataDir);
  assert.deepEqual(gemini.args, []);
  assert.match(gemini.notices[0], /work with Claude Code and Codex/);
  assert.deepEqual((await prepareTools(undefined, "claude", dataDir)).notices, []);
  const tampered = await prepareTools([{ id: "4", hash: "h", kind: "mcp", name: "bad", spec: { transport: "http", url: "http://evil.test" } }], "claude", dataDir);
  assert.match(tampered.notices[0], /bad left out/, "the runner checks definitions too");
});

test("Claude Code receives the servers for that run and the prompt on stdin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tools-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A stand-in for `claude` that reports the MCP servers it was given.
  const fake = join(directory, "claude.mjs");
  await writeFile(fake, `
    import { readFileSync } from "node:fs";
    const at = process.argv.indexOf("--mcp-config");
    const servers = at < 0 ? [] : Object.keys(JSON.parse(readFileSync(process.argv[at + 1], "utf8")).mcpServers);
    const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
    process.stdin.once("data", () => {
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "servers=" + servers.join(",") + " next=" + process.argv[at + 2] } } });
      out({ type: "result", subtype: "success", result: "done" });
      process.exit(0);
    });
  `);
  const claude = agentById("claude");
  const spec = { ...claude, bin: process.execPath, promptArgs: (prompt, options) => [...claude.promptArgs(prompt, options)] };
  const tools = await prepareTools([{ id: "1", hash: "h", ...playwright }], "claude", directory);
  t.after(() => tools.cleanup());
  const result = await runAgentLocally({ spec, prompt: "hi", cwd: directory, onEvent: () => {}, tools: { args: [fake, ...tools.args] } });
  assert.equal(result.code, 0, result.errOutput);
  assert.equal(result.output, "servers=playwright next=--permission-mode");
});

test("Codex asks the chat before an MCP tool runs, and \"always\" lasts for the chat only", () => {
  const params = { serverName: "probe", message: 'Allow the probe MCP server to run tool "ping"?', mode: "form",
    _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { q: 1 } } };
  assert.deepEqual(describeCodexApproval("mcpServer/elicitation/request", params),
    { tool: "mcp", title: "Use ping from probe", detail: JSON.stringify({ q: 1 }, null, 2), rule: "mcp__probe__ping" });
  assert.equal(describeCodexApproval("mcpServer/elicitation/request", { ...params, _meta: {} }), null, "a server's own form is refused");
  assert.deepEqual(codexApprovalResult("mcpServer/elicitation/request", params, true, false), { action: "accept", content: {} });
  assert.deepEqual(codexApprovalResult("mcpServer/elicitation/request", params, true, true), { action: "accept", content: {}, _meta: { persist: "session" } });
  assert.deepEqual(codexApprovalResult("mcpServer/elicitation/request", params, false, false), { action: "decline" });
});
