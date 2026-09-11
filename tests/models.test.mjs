import assert from "node:assert/strict";
import { AGENTS, agentById } from "../app/lib/ai/catalog.ts";
import { createModelDiscovery, discoverModels, normalizeChoices, parseOpenCodeModels, sanitizeCatalog, validModelId } from "../app/lib/ai/model-discovery.ts";
import { createOpenCodeStreamParser } from "../app/lib/ai/opencode-stream.ts";
import { agentEnv } from "../app/lib/ai/env.ts";

let passed = 0;
async function test(name, task) { await task(); passed += 1; console.log(`  ok ${name}`); }
const originalFetch = globalThis.fetch;
const keys = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY"];
const originalKeys = keys.map(key => process.env[key]);
for (const key of keys) delete process.env[key];
try {
  await test("provider IDs are unique and local backends never choose or download a hardcoded model", () => {
    assert.equal(new Set(AGENTS.map(spec => spec.id)).size, AGENTS.length);
    for (const id of ["opencode", "ollama", "codex-ollama", "codex-lmstudio"]) {
      const spec = agentById(id);
      assert.equal(spec.requiresModel, true);
      assert.deepEqual(spec.models, []);
      assert.throws(() => spec.promptArgs("hello"), /Choose/);
      const args = spec.promptArgs("hello", { model: "org/test-model" });
      assert.ok(args.includes("org/test-model"));
      assert.ok(!args.some(arg => /bypass|yolo|--auto/.test(arg)));
      assert.ok(args.indexOf("--") < args.indexOf("hello"));
    }
    const originalHost = process.env.OLLAMA_HOST;
    const originalBase = process.env.CODEX_OSS_BASE_URL;
    try {
      process.env.OLLAMA_HOST = "https://unexpected.example";
      process.env.CODEX_OSS_BASE_URL = "https://unexpected.example";
      assert.equal(agentEnv("ollama").OLLAMA_HOST, "http://127.0.0.1:11434");
      assert.equal(agentEnv("codex-ollama").OLLAMA_HOST, "http://127.0.0.1:11434");
      assert.equal(agentEnv("codex-ollama").CODEX_OSS_BASE_URL, undefined);
      assert.equal(agentEnv("codex-lmstudio").CODEX_OSS_BASE_URL, undefined);
      assert.equal(agentEnv("opencode").OLLAMA_HOST, "https://unexpected.example");
    } finally {
      if (originalHost === undefined) delete process.env.OLLAMA_HOST; else process.env.OLLAMA_HOST = originalHost;
      if (originalBase === undefined) delete process.env.CODEX_OSS_BASE_URL; else process.env.CODEX_OSS_BASE_URL = originalBase;
    }
  });
  await test("model IDs and snapshots reject options, malformed entries, credentials, and arbitrary fields", () => {
    for (const value of ["--config", "model\nflag", "$(touch /tmp/x)", 7, "a".repeat(201)]) assert.equal(validModelId(value), false);
    const catalog = sanitizeCatalog({ opencode: { choices: [{ id: "provider/model", label: "Friendly", apiKey: "secret", efforts: [{ id: 'high"bad' }, { id: "high", secret: "secret" }] }], token: "secret", source: "test", refreshedAt: Date.now() }, unknown: {} });
    assert.equal(JSON.stringify(catalog).includes("secret"), false);
    assert.deepEqual(catalog.opencode.choices[0].efforts, [{ id: "high", label: "high" }]);
    assert.deepEqual(Object.keys(catalog), ["opencode"]);
    const malformedTimes = sanitizeCatalog({ codex: { checkedAt: Infinity, refreshedAt: NaN } }).codex;
    assert.equal(Number.isFinite(malformedTimes.checkedAt), true);
    assert.equal(malformedTimes.refreshedAt, null);
    assert.equal(normalizeChoices(Array.from({ length: 1500 }, (_, index) => ({ id: `model-${index}` }))).length, 1000);
  });
  await test("OpenCode metadata keeps tool-capable text models and drops non-chat or deprecated entries", () => {
    const entry = (id, capabilities, status = "active") => `provider/${id}\n${JSON.stringify({ name: id, capabilities, status, variants: { high: {} }, headers: { authorization: "secret" } }, null, 2)}\n`;
    const text = entry("new-model", { toolcall: true, output: { text: true } }) + entry("embedding", { toolcall: false, output: { text: false } }) + entry("retired", { toolcall: true, output: { text: true } }, "deprecated");
    assert.deepEqual(parseOpenCodeModels(text), [{ id: "provider/new-model", label: "provider · new-model", efforts: [{ id: "high", label: "high" }] }]);
  });
  await test("OpenCode stream decoding surfaces provider errors rather than treating them as successful replies", () => {
    const parser = createOpenCodeStreamParser();
    assert.deepEqual(parser.push('not-json'), []);
    assert.deepEqual(parser.push('{"type":"text","part":{"text":"Done"}}'), [{ kind: "reply", text: "Done" }]);
    assert.deepEqual(parser.push('{"type":"tool_use","part":{"tool":"read"}}'), [{ kind: "activity", text: "read" }]);
    assert.equal(parser.push('{"type":"error","error":{"token":"secret"}}')[0].kind, "error");
    assert.equal(JSON.stringify(parser.push('{"type":"error","error":{"token":"secret"}}')).includes("secret"), false);
  });
  await test("discovery refreshes automatically, coalesces concurrent requests, and removes retired models", async () => {
    let now = 10_000;
    let calls = 0;
    const load = createModelDiscovery(async () => ({ choices: [{ id: `release-${++calls}`, label: "Latest" }], source: "fixture" }), () => now);
    const spec = agentById("opencode");
    await Promise.all([load(spec), load(spec), load(spec)]);
    assert.equal(calls, 1);
    now += 299_999;
    assert.equal((await load(spec)).choices[0].id, "release-1");
    now += 1;
    assert.equal((await load(spec)).choices[0].id, "release-2");
    assert.equal((await load(spec, true)).choices[0].id, "release-2");
    assert.equal(calls, 2);
  });
  await test("failed refresh retains last-known-good metadata temporarily without leaking errors", async () => {
    let now = 10_000;
    let broken = false;
    const load = createModelDiscovery(async () => { if (broken) throw new Error("api-key-secret"); return { choices: [{ id: "local-model", label: "Local" }], source: "fixture" }; }, () => now);
    const spec = agentById("ollama");
    await load(spec);
    broken = true; now += 31_000;
    const stale = await load(spec);
    assert.equal(stale.stale, true);
    assert.equal(stale.choices[0].id, "local-model");
    assert.equal(JSON.stringify(stale).includes("api-key-secret"), false);
    now += 86_400_001;
    assert.deepEqual((await load(spec)).choices, []);
  });
  await test("Claude aliases and Gemini defaults work without reading subscription credentials", async () => {
    globalThis.fetch = () => { throw new Error("No network expected"); };
    assert.ok((await discoverModels(agentById("claude"))).choices.some(choice => choice.id === "sonnet"));
    assert.deepEqual((await discoverModels(agentById("gemini"))).choices.map(choice => choice.id), [""]);
  });
  await test("Google model discovery follows pagination and filters unsupported modalities", async () => {
    process.env.GEMINI_API_KEY = "fixture-key";
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(options.headers["x-goog-api-key"], "fixture-key");
      assert.equal(new URL(url).hostname, "generativelanguage.googleapis.com");
      assert.equal(url.includes("fixture-key"), false);
      calls += 1;
      return Response.json(calls === 1 ? { models: [{ name: "models/gemini-next", displayName: "Next", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "page2" } : { models: [{ name: "models/gemini-tts", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }] });
    };
    assert.deepEqual((await discoverModels(agentById("gemini"))).choices.map(choice => choice.id), ["", "gemini-next"]);
    assert.equal(calls, 2);
  });
  await test("Anthropic discovery follows cursor pagination and retains rolling aliases", async () => {
    process.env.ANTHROPIC_API_KEY = "fixture-key";
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(options.headers["x-api-key"], "fixture-key");
      assert.equal(new URL(url).hostname, "api.anthropic.com");
      calls += 1;
      if (calls === 2) assert.equal(new URL(url).searchParams.get("after_id"), "claude-next");
      return Response.json({ data: [{ id: calls === 1 ? "claude-next" : "claude-other", display_name: "Claude" }], has_more: calls === 1, last_id: "claude-next" });
    };
    assert.ok((await discoverModels(agentById("claude"))).choices.some(choice => choice.id === "claude-other"));
    assert.equal(calls, 2);
  });
  await test("Ollama and LM Studio inventories use fixed local endpoints and exclude embedding models", async () => {
    globalThis.fetch = async url => {
      assert.equal(new URL(url).hostname, "127.0.0.1");
      return Response.json(url.includes("11434") ? { models: [{ name: "my-coder:latest" }] } : { data: [{ id: "local/coder" }, { id: "text-embedding" }] });
    };
    assert.deepEqual((await discoverModels(agentById("ollama"))).choices.map(choice => choice.id), ["my-coder:latest"]);
    assert.deepEqual((await discoverModels(agentById("codex-lmstudio"))).choices.map(choice => choice.id), ["local/coder"]);
  });
  await test("malformed and oversized inventory responses fail safely", async () => {
    globalThis.fetch = async () => Response.json({ data: "wrong" });
    await assert.rejects(discoverModels(agentById("codex-lmstudio")), /format/);
    globalThis.fetch = async () => new Response("x".repeat(4 * 1024 * 1024 + 1));
    await assert.rejects(discoverModels(agentById("ollama")), /size limit/);
  });
  console.log(`\n${passed} model/provider checks passed.`);
} finally {
  globalThis.fetch = originalFetch;
  keys.forEach((key, index) => { if (originalKeys[index] === undefined) delete process.env[key]; else process.env[key] = originalKeys[index]; });
}
