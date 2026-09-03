/**
 * Unit tests for agent prompt assembly (the context-weaving + budgeting that
 * used to be inline in the run route). The rules that matter: layer ordering,
 * per-layer truncation direction, the shared budget, and memory dropping out
 * when the explicit sources already fill the prompt.
 *
 * Run with `npm run test:prompt` — it compiles the TypeScript first.
 */
const assert = require("node:assert/strict");
const { assembleAgentPrompt, MAX_PROMPT } = require("../.test-build/prompt.js");

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

console.log("assembleAgentPrompt");

test("a bare prompt passes through untouched", () => {
  assert.equal(assembleAgentPrompt({ prompt: "hello" }), "hello");
});

test("a co-driven run is tagged with the speaker's handle", () => {
  assert.equal(assembleAgentPrompt({ prompt: "hi", handle: "alice" }), "[@alice] hi");
});

test("no handle means no tag", () => {
  assert.equal(assembleAgentPrompt({ prompt: "hi", handle: null }), "hi");
});

test("each context layer is wrapped only when present", () => {
  const ref = assembleAgentPrompt({ prompt: "p", referencedContext: "R" });
  assert.ok(ref.includes("<referenced-context>\nR\n</referenced-context>"));
  assert.ok(ref.endsWith("p"));

  const imp = assembleAgentPrompt({ prompt: "p", importedContext: "I" });
  assert.ok(imp.includes("<imported-context>\nI\n</imported-context>"));

  const mem = assembleAgentPrompt({ prompt: "p", sharedMemory: "M" });
  assert.ok(mem.includes("<memory>\nM\n</memory>"));
});

test("layers nest outermost→innermost: memory, imported, referenced, prompt", () => {
  const out = assembleAgentPrompt({
    prompt: "PROMPT",
    referencedContext: "REF",
    importedContext: "IMP",
    sharedMemory: "MEM",
  });
  const iMem = out.indexOf("<memory>");
  const iImp = out.indexOf("<imported-context>");
  const iRef = out.indexOf("<referenced-context>");
  const iPrompt = out.indexOf("PROMPT");
  assert.ok(iMem < iImp && iImp < iRef && iRef < iPrompt, `unexpected order: ${out}`);
});

test("referenced context keeps its head and marks the truncation", () => {
  const ref = "R".repeat(500);
  const out = assembleAgentPrompt({ prompt: "p", referencedContext: ref, maxPrompt: 200 });
  assert.ok(out.includes("[…referenced context truncated for length…]"));
  assert.ok(out.startsWith("<referenced-context>\nRRR"), "head of referenced context is kept");
});

test("imported context keeps its TAIL (recent turns) on truncation", () => {
  const imported = "START" + "x".repeat(500) + "END";
  const out = assembleAgentPrompt({ prompt: "p", importedContext: imported, maxPrompt: 200 });
  assert.ok(out.includes("[…earlier context truncated for length…]"));
  assert.ok(out.includes("END"), "the tail (recent) end is retained");
  assert.ok(!out.includes("START"), "the head (earlier) end is dropped");
});

test("memory is dropped, not emitted empty, when explicit sources fill the budget", () => {
  // A referenced block at the cap leaves no budget for memory.
  const out = assembleAgentPrompt({
    prompt: "p",
    referencedContext: "R".repeat(1000),
    sharedMemory: "M".repeat(50),
    maxPrompt: 150,
  });
  assert.ok(!out.includes("<memory>"), "no empty memory block");
  assert.ok(out.includes("<referenced-context>"));
});

test("memory keeps its head and marks truncation when it partially fits", () => {
  const out = assembleAgentPrompt({ prompt: "p", sharedMemory: "M".repeat(500), maxPrompt: 200 });
  assert.ok(out.includes("<memory>\nMMM"), "head of memory is kept");
  assert.ok(out.includes("[…memory truncated for length…]"));
});

test("MAX_PROMPT is the exported default cap", () => {
  assert.equal(MAX_PROMPT, 20_000);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
