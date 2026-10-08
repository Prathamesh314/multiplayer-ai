import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { objectStore, storageConfig } from "./object-store";
import { trackActivityWrite } from "./admission";
import { join } from "node:path";
const zip = promisify(gzip), unzip = promisify(gunzip);
const MAX_BYTES = 256 * 1024;
const validKey = (key: string) => { if (!/^activity\/[0-9a-f-]{36}\/[0-9a-f]{64}\.gz$/.test(key)) throw new Error("Invalid activity object key."); return key; };

/** Write before acknowledging a batch. Keys are scoped to a turn; hashes never grant access. */
export async function storeActivityObject(turnId: string, text: string) {
  const bytes = Buffer.from(text);
  if (bytes.length > MAX_BYTES) throw new Error("Activity batch exceeds 256 KB.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const key = validKey(`activity/${turnId}/${hash}.gz`);
  const compressed = await zip(bytes), config = storageConfig();
  const write = () => objectStore(config).put(key, compressed);
  if (config.provider === "local") await trackActivityWrite(join(config.directory, config.prefix, key), write);
  else await write();
  return { key, hash, bytes: bytes.length };
}
export async function readActivityObject(key: string, expectedHash: string): Promise<string> {
  const stream = await objectStore().read(validKey(key));
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_BYTES + 1024) throw new Error("Invalid activity object size.");
    chunks.push(Buffer.from(chunk));
  }
  const raw = await unzip(Buffer.concat(chunks), { maxOutputLength: MAX_BYTES });
  if (createHash("sha256").update(raw).digest("hex") !== expectedHash) throw new Error("Activity object checksum mismatch.");
  return raw.toString("utf8");
}
export async function removeActivityObject(key: string) { await objectStore().remove(validKey(key)); }

function fileObjectKey(key: string) {
  if (!/^git\/[a-f0-9]{64}\/[a-f0-9]{64}\.bundle$/.test(key)) throw new Error("Invalid Git archive key.");
  return key;
}
export async function storeFileObject(key: string, path: string) { await objectStore().putFile(fileObjectKey(key), path); }
export async function readFileObject(key: string) { return objectStore().read(fileObjectKey(key)); }
export async function removeFileObject(key: string) { await objectStore().remove(fileObjectKey(key)); }
