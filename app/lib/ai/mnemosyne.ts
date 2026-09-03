/*
 * Minimal client for the mnemosyne memory sidecar.
 *
 * mnemosyne-oss is a Python service; we reach it over its MCP "streamable
 * HTTP" transport (a single JSON-RPC route, default `/mcp`). The SDK server is
 * stateful, so a session must be opened with an `initialize` handshake before
 * any tool call — we do that once and reuse the returned `Mcp-Session-Id`.
 *
 * Everything here is best-effort and fail-open: when `MNEMOSYNE_URL` is unset
 * the whole layer is a no-op (recall returns nothing, remember drops), and any
 * transport error is swallowed the same way. A missing or slow memory sidecar
 * must never delay or break an agent run, so every call is bounded by a short
 * timeout and never throws to its caller.
 */

/** One recalled memory, as the caller cares about it. */
export type Memory = {
  content: string;
  importance: number;
  /** Backend relevance score when present; used only to re-rank across banks. */
  score: number;
  /** The room bank it came from, so a caller can label or de-scope it. */
  bank: string;
};

const PROTOCOL_VERSION = "2025-06-18";
/** Recall sits on the run's critical path, so it is kept snappy. */
const RECALL_TIMEOUT_MS = 4000;
/** Writes happen after a run finishes; a little more slack is fine. */
const REMEMBER_TIMEOUT_MS = 6000;

function endpoint(): string | null {
  return process.env.MNEMOSYNE_URL?.trim() || null;
}

function authHeaders(): Record<string, string> {
  const token = process.env.MNEMOSYNE_MCP_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Parse a streamable-HTTP response, which is either a plain JSON body or an
 * SSE frame (`event: message\ndata: {…}`) depending on the server's mode. We
 * run the sidecar with `--json-response`, but handle both so a differently
 * configured server still works.
 */
async function parseRpc(res: Response): Promise<unknown> {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    return data ? JSON.parse(data) : null;
  }
  return text ? JSON.parse(text) : null;
}

/**
 * A live MCP session: its id (echoed back on every request) plus the shared
 * request headers. Cached across calls and rebuilt if it ever goes stale.
 */
type Session = { id: string | null };

let sessionPromise: Promise<Session> | null = null;

async function openSession(url: string): Promise<Session> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...authHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "multiplayer-ai", version: "0.1.0" },
      },
    }),
    signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`mnemosyne initialize failed: ${res.status}`);
  const sessionId = res.headers.get("mcp-session-id");
  // Drain the body so the socket can be reused, and surface a JSON-RPC error.
  const body = (await parseRpc(res)) as { error?: unknown } | null;
  if (body?.error) throw new Error(`mnemosyne initialize error: ${JSON.stringify(body.error)}`);

  // The server expects an `initialized` notification before it accepts calls.
  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      ...authHeaders(),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
  }).catch(() => {});

  return { id: sessionId };
}

function session(url: string): Promise<Session> {
  if (!sessionPromise) {
    sessionPromise = openSession(url).catch((err) => {
      sessionPromise = null; // let the next call try again from scratch
      throw err;
    });
  }
  return sessionPromise;
}

/** Call one mnemosyne tool, retrying once through a fresh session on a stale id. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const url = endpoint();
  if (!url) return null;

  const invoke = async (retrying: boolean): Promise<unknown> => {
    const sess = await session(url);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(sess.id ? { "Mcp-Session-Id": sess.id } : {}),
        ...authHeaders(),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // A 404 means the server forgot our session (restart / eviction); reopen
    // once. Anything else non-2xx is a real failure for this attempt.
    if (res.status === 404 && !retrying) {
      sessionPromise = null;
      return invoke(true);
    }
    if (!res.ok) throw new Error(`mnemosyne ${name} failed: ${res.status}`);

    const body = (await parseRpc(res)) as
      | { result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean }; error?: unknown }
      | null;
    if (body?.error) throw new Error(`mnemosyne ${name} error: ${JSON.stringify(body.error)}`);

    const result = body?.result;
    if (!result) return null;
    // Prefer the structured payload; fall back to the JSON carried as text.
    if (result.structuredContent !== undefined) return result.structuredContent;
    const textPart = result.content?.find((part) => part.type === "text")?.text;
    return textPart ? JSON.parse(textPart) : null;
  };

  return invoke(false);
}

/**
 * Semantically recall memories from one bank. Returns [] on any failure or when
 * the sidecar is not configured — recall is an enhancement, never a hard
 * dependency of a run.
 */
export async function recall(input: {
  bank: string;
  query: string;
  topK: number;
}): Promise<Memory[]> {
  if (!endpoint() || !input.query.trim()) return [];
  try {
    const payload = (await callTool(
      "mnemosyne_recall",
      { query: input.query, top_k: input.topK, bank: input.bank },
      RECALL_TIMEOUT_MS,
    )) as { results?: Array<Record<string, unknown>> } | null;
    const results = payload?.results ?? [];
    return results.map((row) => ({
      content: String(row.content ?? ""),
      importance: Number(row.importance ?? 0),
      score: Number(row.score ?? row.rank ?? row.importance ?? 0),
      bank: input.bank,
    }));
  } catch {
    return [];
  }
}

/**
 * Store one memory into a room's bank. Fire-and-forget: resolves to whether it
 * was accepted, but callers treat a false the same as a slow write — ignore it.
 */
export async function remember(input: {
  bank: string;
  content: string;
  importance: number;
  /** Tagged so a memory carries which room it was learned in. */
  channelId: string;
  source?: string;
}): Promise<boolean> {
  if (!endpoint() || !input.content.trim()) return false;
  try {
    const payload = (await callTool(
      "mnemosyne_remember",
      {
        content: input.content,
        importance: input.importance,
        bank: input.bank,
        channel_id: input.channelId,
        source: input.source ?? "multiplayer-ai",
        scope: "global",
      },
      REMEMBER_TIMEOUT_MS,
    )) as { status?: string } | null;
    return payload?.status === "stored";
  } catch {
    return false;
  }
}

/** True when a memory sidecar is configured; lets callers skip work entirely. */
export function memoryEnabled(): boolean {
  return endpoint() !== null;
}
