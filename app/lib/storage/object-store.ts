import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { dataRoot } from "../session/paths";

export type StorageConfig =
  | { provider: "local"; directory: string; prefix: string }
  | { provider: "s3"; bucket: string; region: string; endpoint?: string; pathStyle: boolean; prefix: string;
      credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } };

/** Cloud storage is always an explicit choice, even if AWS credentials exist. */
export function storageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const provider = env.STORAGE_PROVIDER || "local";
  const prefix = (env.STORAGE_PREFIX || "").replace(/^\/+|\/+$/g, "");
  if (prefix && !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw new Error("Invalid STORAGE_PREFIX.");
  if (provider === "local") return { provider, directory: resolve(env.STORAGE_LOCAL_DIR || join(dataRoot(), "objects")), prefix };
  if (provider !== "s3") throw new Error("Unsupported STORAGE_PROVIDER. Use local or s3 (S3-compatible providers).");
  if (!env.STORAGE_BUCKET) throw new Error("STORAGE_BUCKET is required for cloud storage.");
  if (env.STORAGE_ENDPOINT) {
    const endpoint = new URL(env.STORAGE_ENDPOINT);
    if (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid STORAGE_ENDPOINT.");
  }
  if (env.STORAGE_PATH_STYLE && !["0", "1"].includes(env.STORAGE_PATH_STYLE)) throw new Error("STORAGE_PATH_STYLE must be 0 or 1.");
  if (!!env.STORAGE_ACCESS_KEY_ID !== !!env.STORAGE_SECRET_ACCESS_KEY) throw new Error("Configure both STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY.");
  return { provider, bucket: env.STORAGE_BUCKET, region: env.STORAGE_REGION || "us-east-1", endpoint: env.STORAGE_ENDPOINT || undefined,
    pathStyle: env.STORAGE_PATH_STYLE === "1", prefix,
    credentials: env.STORAGE_ACCESS_KEY_ID ? { accessKeyId: env.STORAGE_ACCESS_KEY_ID, secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY!, sessionToken: env.STORAGE_SESSION_TOKEN || undefined } : undefined };
}

/** Application code uses this interface, independent of the storage vendor. */
export interface ObjectStore {
  put(key: string, bytes: Buffer): Promise<void>;
  putFile(key: string, path: string): Promise<void>;
  read(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}
function objectKey(config: StorageConfig, key: string) {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(key) || key.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid storage object key.");
  return config.prefix ? `${config.prefix}/${key}` : key;
}
async function atomicFile(path: string, write: (temporary: string) => Promise<void>) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await write(temporary); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export function objectStore(config = storageConfig()): ObjectStore {
  if (config.provider === "local") {
    const path = (key: string) => join(config.directory, objectKey(config, key));
    return {
      put: (key, bytes) => atomicFile(path(key), temporary => writeFile(temporary, bytes, { mode: 0o600, flush: true })),
      putFile: (key, source) => atomicFile(path(key), async temporary => {
        await copyFile(source, temporary);
        const file = await open(temporary, "r+");
        try { await file.chmod(0o600); await file.sync(); } finally { await file.close(); }
      }),
      read: async key => createReadStream(path(key)),
      remove: key => rm(path(key), { force: true }),
    };
  }
  const connection = async () => {
    const sdk = await import("@aws-sdk/client-s3");
    return { sdk, client: new sdk.S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: config.pathStyle,
      credentials: config.credentials, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" }) };
  };
  return {
    async put(key, bytes) {
      const Key = objectKey(config, key), { sdk, client } = await connection();
      try { await client.send(new sdk.PutObjectCommand({ Bucket: config.bucket, Key, Body: bytes })); }
      finally { client.destroy(); }
    },
    async putFile(key, path) {
      const Key = objectKey(config, key), size = (await stat(path)).size;
      const { sdk, client } = await connection(), stream = createReadStream(path);
      try { await client.send(new sdk.PutObjectCommand({ Bucket: config.bucket, Key, Body: stream, ContentLength: size })); }
      finally { stream.destroy(); client.destroy(); }
    },
    async read(key) {
      const Key = objectKey(config, key), { sdk, client } = await connection();
      try {
        const response = await client.send(new sdk.GetObjectCommand({ Bucket: config.bucket, Key }));
        const stream = response.Body as Readable;
        if (!stream) throw new Error("Missing storage object body.");
        stream.once("close", () => client.destroy()); return stream;
      } catch (cause) { client.destroy(); throw cause; }
    },
    async remove(key) {
      const Key = objectKey(config, key), { sdk, client } = await connection();
      try { await client.send(new sdk.DeleteObjectCommand({ Bucket: config.bucket, Key })); }
      finally { client.destroy(); }
    },
  };
}
