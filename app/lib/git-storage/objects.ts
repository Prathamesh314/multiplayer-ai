import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type { StorageConfig } from "./config";

export interface GitObjectStore {
  putFile(key: string, file: string): Promise<void>;
  getFile(key: string, destination: string): Promise<void>;
}

/** Local backend is also useful for protocol-independent storage tests. */
export class LocalObjectStore implements GitObjectStore {
  constructor(private root: string) {}
  private path(key: string) {
    const root = resolve(this.root), path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new Error("Invalid object key.");
    return path;
  }
  async putFile(key: string, file: string) {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await copyFile(file, tmp);
    await rename(tmp, target);
  }
  async getFile(key: string, destination: string) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(this.path(key), destination);
  }
}

export async function s3ObjectStore(config: StorageConfig, clientOverride?: import("@aws-sdk/client-s3").S3Client): Promise<GitObjectStore> {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { Upload } = await import("@aws-sdk/lib-storage");
  // Standard AWS credential chain: IAM/workload identity or environment. No
  // credentials are persisted in repository metadata or sent to a browser.
  const client = clientOverride ?? new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: config.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  return {
    async putFile(key, file) {
      await new Upload({ client, params: { Bucket: config.bucket, Key: `${config.prefix}/${key}`, Body: createReadStream(file), ContentType: "application/x-git-bundle" },
        queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false }).done();
    },
    async getFile(key, destination) {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}/${key}` }));
      if (!result.Body) throw new Error("Missing Git bundle body.");
      await mkdir(dirname(destination), { recursive: true });
      await pipeline(result.Body as Readable, createWriteStream(destination, { flags: "wx" }));
    },
  };
}
