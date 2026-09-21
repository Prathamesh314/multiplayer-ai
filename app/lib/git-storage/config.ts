import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const instance = `${process.pid}-${randomUUID()}`;
export type StorageConfig = {
  mode: "local" | "shadow" | "cloud";
  cacheRoot: string;
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
};
const operationConfig = new AsyncLocalStorage<StorageConfig>();
export const withStorageConfig = <T>(config: StorageConfig,task:()=>Promise<T>) => operationConfig.run(config,task);

/** Read on every operation, not at build time. Never silently downgrade cloud
 * storage when its configuration or provider is unavailable. */
export function gitStorageConfig(): StorageConfig {
  const pinned=operationConfig.getStore();
  if(pinned) return pinned;
  const environment = process.env.APP_ENV ?? process.env.NODE_ENV ?? "development";
  if (!["test", "testing", "development", "production"].includes(environment)) throw new Error("APP_ENV must be testing, development, or production.");
  const testing = environment === "test" || environment === "testing";
  const phase = process.env.GIT_STORAGE_PHASE;
  if (phase && !["shadow", "cloud"].includes(phase)) throw new Error("GIT_STORAGE_PHASE must be shadow or cloud.");
  const mode = testing ? "local" : phase === "shadow" ? "shadow" : "cloud";
  const bucket = process.env.GIT_S3_BUCKET?.trim() ?? "";
  if (mode !== "local" && !bucket) throw new Error("GIT_S3_BUCKET is required outside testing. Configure cloud storage or set APP_ENV=testing for local tests.");
  const prefix = (process.env.GIT_S3_PREFIX ?? "multiplayer-git").replace(/^\/+|\/+$/g, "");
  if (!/^[a-zA-Z0-9/_-]+$/.test(prefix)) throw new Error("Invalid GIT_S3_PREFIX.");
  const namespace=createHash('sha256').update(JSON.stringify([bucket,prefix,process.env.GIT_S3_ENDPOINT,process.env.AWS_REGION])).digest('hex').slice(0,16);
  return { mode, bucket, prefix, region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.GIT_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.GIT_S3_FORCE_PATH_STYLE === "true",
    cacheRoot: mode === "cloud"
      ? join(resolve(process.env.GIT_CACHE_DIR || tmpdir()), `multiplayer-git-${instance}`,namespace)
      : resolve(process.env.MULTIPLAYER_AI_DATA || ".multiplayer-ai"),
  };
}

export type RepoKey = `repos/${string}` | `projects/${string}`;
export function repoKey(id: string, project = false): RepoKey {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) throw new Error("Invalid repository ID.");
  return `${project ? "projects" : "repos"}/${id}`;
}
