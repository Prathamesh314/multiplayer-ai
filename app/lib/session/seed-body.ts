import { gunzipSync } from "node:zlib";

/**
 * Reading an upload batch, compressed or not.
 *
 * Folder imports are the one request in this application whose cost is almost
 * entirely bytes on the wire: the Git side writes 10,000 files in about a
 * second, so what an import actually spends is transfer. Source code gzips to
 * roughly a third of the base64 JSON that used to be sent, which is the single
 * biggest lever available without changing the wire format.
 *
 * Older clients (and the desktop app until it updates) still send plain JSON,
 * so the encoding is optional and chosen by the client's `content-encoding`.
 */

/**
 * Decompressed ceiling. The gateway caps the *compressed* body, which a highly
 * compressible payload can slip under while expanding to something that would
 * exhaust memory here. Generous next to the ~6 MiB batches the client sends,
 * and the per-batch file and size checks still apply afterwards.
 */
const MAX_DECOMPRESSED_BYTES = 96 * 1024 * 1024;

export class SeedBodyError extends Error {}

/** The parsed batch body, inflating it first when the client compressed it. */
export async function readSeedBody(request: Request): Promise<unknown> {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (!encoding || encoding === "identity") return request.json();
  if (encoding !== "gzip") throw new SeedBodyError("Unsupported content encoding.");

  let json: string;
  try {
    // maxOutputLength makes zlib stop at the ceiling rather than allocate past
    // it, so a decompression bomb fails as a 400 instead of taking the process
    // down with it.
    json = gunzipSync(Buffer.from(await request.arrayBuffer()), { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString("utf8");
  } catch {
    throw new SeedBodyError("Could not read the compressed upload.");
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new SeedBodyError("Expected a JSON body.");
  }
}
