import { createHash } from "node:crypto";

export type EmbeddingConfig = { url: string; model: string; dimensions: number; key: string; apiKey?: string;
  queryPrefix: string; documentPrefix: string };

/** Separate from conversation memory. Changing model/endpoint/dimensions
 * invalidates old vectors without invalidating the source/keyword index. */
export function repoEmbeddingConfig(): EmbeddingConfig | null {
  const url = (process.env.REPO_EMBEDDING_URL ?? "http://localhost:11435/v1/embeddings").trim();
  const model = (process.env.REPO_EMBEDDING_MODEL ?? "nomic-embed-text:v1.5").trim();
  if (!url || !model) return null;
  const dimensions = Number(process.env.REPO_EMBEDDING_DIMENSIONS || "768");
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16000) {
    throw new Error("REPO_EMBEDDING_DIMENSIONS must be an integer between 1 and 16000");
  }
  new URL(url);
  const nomic = model.startsWith("nomic-embed-text");
  const queryPrefix = process.env.REPO_EMBEDDING_QUERY_PREFIX ?? (nomic ? "search_query: " : "");
  const documentPrefix = process.env.REPO_EMBEDDING_DOCUMENT_PREFIX ?? (nomic ? "search_document: " : "");
  return { url, model, dimensions, apiKey: process.env.REPO_EMBEDDING_API_KEY,
    queryPrefix, documentPrefix,
    key: createHash("sha256").update(JSON.stringify([url, model, dimensions, queryPrefix, documentPrefix])).digest("hex") };
}

/** OpenAI-compatible embeddings protocol; the endpoint may be local or hosted.
 * Reject partial, reordered-without-index, nonfinite, zero and wrong-size data. */
export async function embedRepoTexts(config: EmbeddingConfig, texts: string[], timeoutMs = 30_000, kind: "query" | "document" = "document"): Promise<number[][]> {
  if (!texts.length) return [];
  const response = await fetch(config.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({ model: config.model, input: texts.map((text) => `${kind === "query" ? config.queryPrefix : config.documentPrefix}${text}`), dimensions: config.dimensions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Repo embedding request failed (${response.status})`);
  const body = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
  if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error("Incomplete repo embeddings");
  const result: number[][] = new Array(texts.length);
  for (const row of body.data) {
    if (!Number.isInteger(row.index) || row.index < 0 || row.index >= texts.length || result[row.index] ||
        !Array.isArray(row.embedding) || row.embedding.length !== config.dimensions ||
        !row.embedding.every((value) => typeof value === "number" && Number.isFinite(value)) ||
        !row.embedding.some((value) => value !== 0)) throw new Error("Invalid repo embedding vector");
    result[row.index] = row.embedding;
  }
  return result;
}
