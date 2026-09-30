export async function limitedJson(request: Request, limit = 256 * 1024): Promise<unknown> {
  if (!request.body) throw new Error("Expected a JSON body.");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > limit) { await reader.cancel(); throw new Error("Request body exceeds the size limit."); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
