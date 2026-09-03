/**
 * Unit tests for the Claude stream-json decoder. The rules that matter: reply
 * text and thinking are surfaced separately, a tool call's input (which arrives
 * split across many lines, keyed by content-block index) is reassembled into
 * one activity line at block close, and non-content lines are ignored.
 *
 * Run with `npm run test:stream` — it compiles the TypeScript first.
 */
const assert = require("node:assert/strict");
const { createClaudeStreamParser } = require("../.test-build/stream.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`      ${err && err.message ? err.message : err}`);
  }
}

/** Feed lines through a fresh parser and collect all emitted pieces. */
function run(lines) {
  const parser = createClaudeStreamParser();
  const pieces = [];
  for (const line of lines) pieces.push(...parser.push(line));
  return pieces;
}

const delta = (d) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: d } });

console.log("createClaudeStreamParser");

test("reply text_delta becomes a reply piece", () => {
  const pieces = run([delta({ type: "text_delta", text: "Hello" })]);
  assert.deepEqual(pieces, [{ kind: "reply", text: "Hello" }]);
});

test("thinking_delta becomes a thinking piece", () => {
  const pieces = run([delta({ type: "thinking_delta", thinking: "Let me think" })]);
  assert.deepEqual(pieces, [{ kind: "thinking", text: "Let me think" }]);
});

test("signature_delta and non-content lines are ignored", () => {
  const pieces = run([
    delta({ type: "signature_delta", signature: "abc" }),
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "result", is_error: false }),
    "not json at all",
    "",
  ]);
  assert.deepEqual(pieces, []);
});

test("a tool call is reassembled into one activity line at block close", () => {
  const pieces = run([
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t1", name: "Read", input: {} },
      },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"file_path":"' } },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'note.txt"}' } },
    }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
  ]);
  assert.deepEqual(pieces, [{ kind: "activity", text: "Read note.txt" }]);
});

test("a Bash tool shows its command", () => {
  const pieces = run([
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Bash", input: {} } },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"npm test\\nsecond line"}' } },
    }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
  ]);
  assert.deepEqual(pieces, [{ kind: "activity", text: "Bash: npm test" }]);
});

test("interleaved thinking, tool call, and reply keep their order", () => {
  const pieces = run([
    delta({ type: "thinking_delta", thinking: "planning" }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", name: "Write", input: {} } },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"file_path":"out.txt"}' } },
    }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 2 } }),
    delta({ type: "text_delta", text: "Done" }),
  ]);
  assert.deepEqual(pieces, [
    { kind: "thinking", text: "planning" },
    { kind: "activity", text: "Write out.txt" },
    { kind: "reply", text: "Done" },
  ]);
});

test("malformed tool input still yields the tool name", () => {
  const pieces = run([
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "Grep", input: {} } },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pattern": "foo' } },
    }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
  ]);
  assert.deepEqual(pieces, [{ kind: "activity", text: "Grep" }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
