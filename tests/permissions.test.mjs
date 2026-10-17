// Asking the chat before an agent uses a tool: Claude Code's stdio protocol and
// Codex approvals mapped to chat requests, the runner's asker and paused time
// limit, the server's request lifecycle, and the runner driving a CLI that
// speaks the real protocol.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryFixture } from "./helpers/memory-fixture.mjs";
import { allowResponse, denyResponse, describeToolUse, suggestedRule } from "../runner/claude-control.ts";
import { codexApprovalResult, describeCodexApproval } from "../runner/codex-session.ts";
import { Deadline, permissionAsker } from "../runner/permissions.ts";
import { runAgentLocally } from "../runner/execute.ts";
import { agentById } from "../app/lib/ai/catalog.ts";
import { createRun } from "../app/lib/ai/runs.ts";
import { reserveTurn } from "../app/lib/ai/turns.ts";
import { allowedTools, decidePermission, expirePermission, listPermissions, permissionStatus, requestPermission } from "../app/lib/ai/permissions.ts";

const webFetch = {
  subtype: "can_use_tool", tool_name: "WebFetch", display_name: "WebFetch",
  input: { url: "https://docs.google.com/spreadsheets/d/x", prompt: "read it" }, description: "https://docs.google.com/spreadsheets/d/x",
  permission_suggestions: [{ type: "addRules", destination: "localSettings", behavior: "allow", rules: [{ toolName: "WebFetch", ruleContent: "domain:docs.google.com" }] }],
};

test("Claude Code tool requests read clearly in the chat, with the CLI's own rule", () => {
  assert.deepEqual(describeToolUse(webFetch), {
    tool: "WebFetch", title: "WebFetch: https://docs.google.com/spreadsheets/d/x",
    detail: JSON.stringify(webFetch.input, null, 2), rule: "WebFetch(domain:docs.google.com)",
  });
  const drive = describeToolUse({ subtype: "can_use_tool", tool_name: "mcp__claude_ai_Google_Drive__read_file_content", input: { fileId: "1" },
    permission_suggestions: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "mcp__claude_ai_Google_Drive__read_file_content" }] }] });
  assert.equal(drive.title, "Use read file content from Google Drive");
  assert.equal(drive.rule, "mcp__claude_ai_Google_Drive__read_file_content");
  assert.equal(suggestedRule({ subtype: "can_use_tool", tool_name: "Bash" }), null);
  assert.deepEqual(allowResponse("r1", webFetch), { type: "control_response", response: { subtype: "success", request_id: "r1", response: { behavior: "allow", updatedInput: webFetch.input } } });
  assert.deepEqual(denyResponse("r1", "no").response.response, { behavior: "deny", message: "no" });
});

test("Codex approvals map to chat requests and the decisions Codex expects", () => {
  const network = { command: "curl https://example.com", networkApprovalContext: { host: "example.com", protocol: "https" } };
  assert.deepEqual(describeCodexApproval("item/commandExecution/requestApproval", network),
    { tool: "network", title: "Connect to example.com", detail: "curl https://example.com", rule: "CodexNetwork(example.com)" });
  assert.equal(describeCodexApproval("item/commandExecution/requestApproval", { command: "rm -rf build" }).title, "Run: rm -rf build");
  assert.equal(describeCodexApproval("item/tool/requestUserInput", {}), null, "anything else is refused");
  assert.deepEqual(codexApprovalResult("item/commandExecution/requestApproval", network, true, false), { decision: "accept" });
  assert.deepEqual(codexApprovalResult("item/commandExecution/requestApproval", network, true, true), { decision: "acceptForSession" });
  assert.deepEqual(codexApprovalResult("item/fileChange/requestApproval", {}, false, false), { decision: "decline" });
  const permissions = { permissions: { network: { enabled: true }, fileSystem: null } };
  assert.deepEqual(codexApprovalResult("item/permissions/requestApproval", permissions, true, false), { permissions: { network: { enabled: true } }, scope: "turn" });
  assert.deepEqual(codexApprovalResult("item/permissions/requestApproval", permissions, false, false), { permissions: {}, scope: "turn" });
});

test("the runner asks once per rule, waits for an answer, and gives up in time", async () => {
  const asked = [], statuses = new Map(), expired = [];
  const transport = {
    ask: async (body) => { asked.push(body); return statuses.get("initial") ?? "pending"; },
    status: async (id) => statuses.get(id) ?? { status: "pending" },
    expire: async (id) => { expired.push(id); },
  };
  const ask = permissionAsker(transport, ["WebFetch(domain:example.com)"], { pollMs: 5, waitMs: 200 });
  assert.deepEqual(await ask({ tool: "WebFetch", title: "x", rule: "WebFetch(domain:example.com)" }), { allow: true, always: true });
  assert.equal(asked.length, 0, "a rule the chat always allows is not asked");

  const pending = ask({ tool: "WebFetch", title: "Fetch docs", rule: "WebFetch(domain:docs.google.com)" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  statuses.set(asked[0].id, { status: "allowed", remember: true });
  assert.deepEqual(await pending, { allow: true, always: true });
  assert.deepEqual(await ask({ tool: "WebFetch", title: "again", rule: "WebFetch(domain:docs.google.com)" }), { allow: true, always: true });
  assert.equal(asked.length, 1, "always-allowed during the turn is remembered");

  assert.deepEqual(await ask({ tool: "Bash", title: "Run: make", rule: null }), { allow: false, always: false }, "no answer in time is a refusal");
  assert.equal(expired.length, 1);
});

test("the run's time limit stops while someone decides", async () => {
  let fired = false;
  const deadline = new Deadline(60, () => { fired = true; });
  await deadline.hold(() => new Promise((resolve) => setTimeout(resolve, 120)));
  assert.equal(fired, false, "paused during the wait");
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(fired, true, "resumes afterwards");
  deadline.clear();
});

test("requests are answered by the chat's driver only, and always-allow is remembered", async () => {
  const f = await memoryFixture();
  try {
    const run = await createRun({ sessionId: f.room, startedBy: f.alice, agentId: "claude", baseSha: "a".repeat(40) });
    const turnId = randomUUID();
    await reserveTurn(run.id, f.alice, turnId, 0);
    await f.db.query(`UPDATE agent_turns SET status='running' WHERE id=$1`, [turnId]); // claimed by the driver's computer
    const job = { turnId, runId: run.id, sessionId: f.room };
    const first = randomUUID();
    const request = { id: first, tool: "WebFetch", title: "WebFetch: https://docs.google.com/x", detail: "{}", rule: "WebFetch(domain:docs.google.com)" };
    assert.equal(await requestPermission(job, request), "pending");
    assert.equal(await requestPermission(job, request), "pending", "idempotent");
    assert.equal((await listPermissions(run.id))[0].title, request.title);

    const decide = (userId, decision, requestId = first) => decidePermission({ sessionId: f.room, runId: run.id, requestId, userId, decision });
    await assert.rejects(decide(f.bob, "allow"), (e) => e.status === 403, "another editor cannot approve tools on Alice's computer");
    await assert.rejects(decide(f.alice, "maybe"), /Choose/);
    assert.equal(await decide(f.alice, "always"), "allowed");
    assert.deepEqual(await permissionStatus(turnId, first), { status: "allowed", remember: true });
    await assert.rejects(decide(f.alice, "deny"), (e) => e.status === 409, "answered once");
    assert.deepEqual(await allowedTools(run.id), ["WebFetch(domain:docs.google.com)"]);
    assert.equal(await requestPermission(job, { ...request, id: randomUUID() }), "allowed", "a remembered rule is granted at once");

    const shell = randomUUID();
    await requestPermission(job, { id: shell, tool: "Bash", title: "Run: make", rule: "Bash(rm -rf (everything))" });
    assert.equal((await listPermissions(run.id)).find((item) => item.id === shell).rule, null, "malformed rules are not kept");
    await expirePermission(job, shell);
    assert.equal((await permissionStatus(turnId, shell)).status, "expired");

    const late = randomUUID();
    await requestPermission(job, { id: late, tool: "WebSearch", title: "Search" });
    await f.db.query(`UPDATE agent_turns SET status='completed', ended_at=now() WHERE id=$1`, [turnId]);
    assert.equal((await listPermissions(run.id)).find((item) => item.id === late).status, "expired", "a finished turn no longer waits");
    await assert.rejects(decide(f.alice, "allow", late), (e) => e.status === 409);
    await assert.rejects(requestPermission(job, { id: "nope", tool: "x", title: "y" }), /Invalid/);
  } finally {
    await f.close();
  }
});

test("the runner relays Claude Code's stdio permission protocol and sends the prompt on stdin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "permission-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A stand-in for `claude`: reads the prompt as a stream-json user message,
  // asks to use WebFetch, then reports the decision and ends.
  const fake = join(directory, "claude.mjs");
  await writeFile(fake, `
    const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
    const settings = process.argv.includes("--settings") ? process.argv[process.argv.indexOf("--settings") + 1] : "none";
    let buffer = "", prompt = "";
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      for (let i; (i = buffer.indexOf("\\n")) >= 0;) {
        const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
        if (message.type === "user") {
          prompt = message.message.content[0].text;
          out({ type: "control_request", request_id: "req-1", request: ${JSON.stringify(webFetch)} });
        } else if (message.type === "control_response") {
          const answer = message.response.response;
          out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta",
            text: "prompt=" + prompt.length + " " + answer.behavior + " url=" + (answer.updatedInput?.url ?? "-") + " settings=" + settings } } });
          out({ type: "result", subtype: "success", result: "done" });
        }
      }
    });
    process.stdin.on("end", () => process.exit(0));
  `);
  const claude = agentById("claude");
  const spec = { ...claude, bin: process.execPath, promptArgs: (prompt, options) => [fake, ...claude.promptArgs(prompt, options)] };
  const prompt = "x".repeat(200_000); // far past any command-line limit
  const asked = [];
  const run = (answer, allowed) => runAgentLocally({ spec, prompt, cwd: directory, onEvent: () => {}, allowedTools: allowed,
    permissions: async (request) => { asked.push(request); return answer; } });

  const allowed = await run({ allow: true, always: false });
  assert.equal(allowed.code, 0, allowed.errOutput);
  assert.equal(allowed.output, "prompt=200000 allow url=https://docs.google.com/spreadsheets/d/x settings=none");
  assert.equal(asked[0].rule, "WebFetch(domain:docs.google.com)");

  const denied = await run({ allow: false, always: false }, ["WebFetch(domain:docs.google.com)"]);
  assert.equal(denied.code, 0, denied.errOutput);
  assert.equal(denied.output, `prompt=200000 deny url=- settings=${JSON.stringify({ permissions: { allow: ["WebFetch(domain:docs.google.com)"] } })}`);

  const nobody = await runAgentLocally({ spec, prompt: "hi", cwd: directory, onEvent: () => {} });
  assert.match(nobody.output, /^prompt=2 deny/, "without an asker, requests are refused as before");
});
