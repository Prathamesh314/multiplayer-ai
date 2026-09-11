import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { agentEnv } from "./env";
import { AGENTS, type AgentChoice, type AgentSpec, type ModelInventory } from "./catalog";

const MAX_MODELS = 1000;
const MAX_BYTES = 4 * 1024 * 1024;
const REFRESH_MS = 5 * 60_000;
const STALE_MS = 24 * 60 * 60_000;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function validModelId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]*$/.test(value);
}

export function normalizeChoices(values: unknown, allowDefault = true): AgentChoice[] {
  const choices = new Map<string, AgentChoice>();
  for (const value of array(values).slice(0, MAX_MODELS)) {
    const entry = record(value);
    if (!validModelId(entry.id) && !(allowDefault && entry.id === "")) continue;
    const id = entry.id as string;
    const label = typeof entry.label === "string" ? entry.label.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160) : id;
    const efforts = array(entry.efforts).map(record).filter(effort => typeof effort.id === "string" && /^[a-z]{1,20}$/.test(effort.id))
      .slice(0, 12).map(effort => ({ id: effort.id as string, label: effort.id as string }));
    choices.set(id, { id, label: label || "Auto · CLI default", efforts });
  }
  return [...choices.values()];
}

export function parseOpenCodeModels(output: string): AgentChoice[] {
  const choices: AgentChoice[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index].trim();
    if (!validModelId(id) || !id.includes("/") || lines[index + 1]?.trim() !== "{") continue;
    const json: string[] = [];
    index += 1;
    do { json.push(lines[index]); } while (index + 1 < lines.length && lines[index++].trimEnd() !== "}");
    index -= 1;
    let model: RecordValue;
    try { model = record(JSON.parse(json.join("\n"))); } catch { continue; }
    const capabilities = record(model.capabilities);
    if (model.status === "deprecated" || capabilities.toolcall !== true || record(capabilities.output).text !== true) continue;
    choices.push({ id, label: `${id.split("/")[0]} · ${typeof model.name === "string" ? model.name : id}`, efforts: Object.keys(record(model.variants)).map(id => ({ id, label: id })) });
  }
  return normalizeChoices(choices, false);
}

function command(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: homedir(), env: { ...agentEnv(), NO_COLOR: "1" }, timeout: 15_000, maxBuffer: MAX_BYTES, windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error("Model discovery command failed. Check the CLI installation and connection on this machine."));
      else resolve(stdout);
    });
  });
}

export function codexModels(): Promise<AgentChoice[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { cwd: homedir(), env: agentEnv(), stdio: ["pipe", "pipe", "ignore"] });
    let done = false;
    let buffer = "";
    let bytes = 0;
    let pages = 0;
    const models: unknown[] = [];
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else {
        const visible = models.map(record).filter(model => model.hidden !== true);
        const choices = visible.map(model => ({ id: model.model ?? model.id, label: model.displayName,
          efforts: array(model.supportedReasoningEfforts).map(value => ({ id: record(value).reasoningEffort })) }));
        const defaultModel = visible.find(model => model.isDefault === true);
        resolve(normalizeChoices([{ id: "", label: "Auto · CLI default", efforts: array(defaultModel?.supportedReasoningEfforts).map(value => ({ id: record(value).reasoningEffort })) }, ...choices]));
      }
    };
    const timer = setTimeout(() => finish(new Error("Codex model discovery timed out.")), 12_000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + "\n");
    child.on("error", () => finish(new Error("Codex model discovery could not start.")));
    child.stdin.on("error", () => finish(new Error("Codex model discovery disconnected.")));
    child.on("close", () => { if (!done) finish(new Error("Codex closed before returning its models.")); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BYTES) { finish(new Error("Model inventory exceeded its size limit.")); return; }
      buffer += chunk;
      let newline;
      while (!done && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.error) { finish(new Error("Codex could not list models. Update the CLI or check its sign-in.")); return; }
        if (message.id === 0) {
          send({ method: "initialized", params: {} });
          send({ id: 1, method: "model/list", params: { limit: 100, includeHidden: false } });
        } else if (message.id === 1) {
          if (!Array.isArray(message.result?.data)) { finish(new Error("Unexpected Codex inventory format.")); return; }
          models.push(...message.result.data);
          if (message.result.nextCursor && ++pages < 10) send({ id: 1, method: "model/list", params: { limit: 100, includeHidden: false, cursor: message.result.nextCursor } });
          else finish(message.result.nextCursor ? new Error("Codex inventory pagination limit reached.") : undefined);
        }
      }
    });
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "multiplayer_ai_models", version: "1.0.0" } } });
  });
}

async function json(url: string, headers: Record<string, string> = {}): Promise<RecordValue> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!response.ok) throw new Error(`Model inventory request failed (${response.status}). Check the provider connection.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty model inventory response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) throw new Error("Model inventory exceeded its size limit.");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export async function discoverModels(spec: AgentSpec): Promise<{ choices: AgentChoice[]; source: string }> {
  if (spec.id === "codex") return { choices: await codexModels(), source: "Codex model/list" };
  if (spec.id === "opencode") return { choices: parseOpenCodeModels(await command("opencode", ["models", "--refresh", "--verbose", "--pure"])), source: "OpenCode configured providers" };
  if (spec.id === "ollama" || spec.id === "codex-ollama") {
    const data = await json("http://127.0.0.1:11434/api/tags");
    if (!Array.isArray(data.models)) throw new Error("Unexpected Ollama inventory format.");
    return { choices: normalizeChoices(data.models.map(value => ({ id: record(value).name, label: record(value).name })), false), source: "Ollama installed models · localhost:11434" };
  }
  if (spec.id === "codex-lmstudio") {
    const data = await json("http://127.0.0.1:1234/v1/models");
    if (!Array.isArray(data.data)) throw new Error("Unexpected LM Studio inventory format.");
    return { choices: normalizeChoices(data.data.map(value => ({ id: record(value).id, label: record(value).id })).filter(value => typeof value.id === "string" && !/embed/i.test(value.id)), false), source: "LM Studio served models · localhost:1234" };
  }
  const key = spec.id === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) return { choices: normalizeChoices(spec.models), source: spec.id === "claude" ? "Claude Code rolling aliases" : "Gemini CLI default · connect an API key for individual models" };
  const choices: AgentChoice[] = [...spec.models];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const url = new URL(spec.id === "claude" ? "https://api.anthropic.com/v1/models?limit=100" : "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
    if (cursor) url.searchParams.set(spec.id === "claude" ? "after_id" : "pageToken", cursor);
    const headers: Record<string, string> = spec.id === "claude" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { "x-goog-api-key": key };
    const data = await json(url.toString(), headers);
    const values = data[spec.id === "claude" ? "data" : "models"];
    if (!Array.isArray(values)) throw new Error("Unexpected provider inventory format.");
    for (const value of values) {
      const model = record(value);
      if (spec.id === "claude") choices.push({ id: model.id as string, label: model.display_name as string });
      else if (typeof model.name === "string" && model.name.startsWith("models/gemini-") && array(model.supportedGenerationMethods).includes("generateContent") && !/image|tts|live|computer-use/i.test(model.name)) choices.push({ id: model.name.slice(7), label: model.displayName as string });
    }
    cursor = spec.id === "claude" ? data.has_more ? data.last_id as string : undefined : data.nextPageToken as string;
    if (!cursor) return { choices: normalizeChoices(choices), source: spec.id === "claude" ? "Anthropic Models API + rolling aliases" : "Google Models API" };
  }
  throw new Error("Provider inventory pagination limit reached.");
}

export function createModelDiscovery(loader = discoverModels, now = Date.now) {
  const cache = new Map<string, ModelInventory>();
  const pending = new Map<string, Promise<ModelInventory>>();
  return async (spec: AgentSpec, force = false): Promise<ModelInventory> => {
    const previous = cache.get(spec.id);
    const ttl = spec.id.includes("ollama") || spec.id.includes("lmstudio") ? 30_000 : REFRESH_MS;
    if (previous && now() - previous.checkedAt < (force ? 5000 : ttl)) return previous;
    const inflight = pending.get(spec.id);
    if (inflight) return inflight;
    const task = (async () => {
      let result: ModelInventory;
      try {
        const found = await loader(spec);
        result = { choices: normalizeChoices(found.choices, !spec.requiresModel), source: found.source, checkedAt: now(), refreshedAt: now(), stale: false };
      } catch {
        const usable = previous?.refreshedAt && now() - previous.refreshedAt < STALE_MS ? previous : null;
        result = { choices: usable?.choices ?? normalizeChoices(spec.models.map(choice => ({ ...choice, efforts: spec.efforts })), !spec.requiresModel), source: usable?.source ?? "CLI defaults", checkedAt: now(), refreshedAt: usable?.refreshedAt ?? null, stale: true,
          error: "Model refresh failed. Check this provider on the execution machine; cached choices are shown when available." };
      }
      cache.set(spec.id, result);
      return result;
    })().finally(() => pending.delete(spec.id));
    pending.set(spec.id, task);
    return task;
  };
}

export const modelInventory = createModelDiscovery();

export async function assertAvailableModel(spec: AgentSpec, model?: string, effort?: string): Promise<void> {
  const inventory = await modelInventory(spec, true);
  const selected = inventory.choices.find(choice => choice.id === (model ?? ""));
  if (!selected || (effort && !selected.efforts?.some(choice => choice.id === effort))) {
    throw new Error("The selected model or effort is no longer available on this machine. Refresh models and choose again.");
  }
}

export function sanitizeCatalog(value: unknown): Record<string, ModelInventory> {
  const input = record(value);
  const catalog: Record<string, ModelInventory> = {};
  for (const spec of AGENTS) {
    if (!Object.hasOwn(input, spec.id)) continue;
    const item = record(input[spec.id]);
    catalog[spec.id] = {
      choices: normalizeChoices(item.choices, !spec.requiresModel),
      source: typeof item.source === "string" ? item.source.slice(0, 100) : "Runner inventory",
      checkedAt: typeof item.checkedAt === "number" && Number.isFinite(item.checkedAt) ? Math.max(0, Math.min(Date.now(), item.checkedAt)) : Date.now(),
      refreshedAt: typeof item.refreshedAt === "number" && Number.isFinite(item.refreshedAt) ? Math.max(0, Math.min(Date.now(), item.refreshedAt)) : null,
      stale: item.stale === true,
      ...(item.error ? { error: "Your runner could not refresh this provider's models." } : {}),
    };
  }
  return catalog;
}
