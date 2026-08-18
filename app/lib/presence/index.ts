import { createMemoryPresence } from "./memory";
import { createRedisPresence, type RedisLike } from "./redis";
import type { Presence } from "./types";

export * from "./types";
export { createMemoryPresence } from "./memory";
export { createRedisPresence, type RedisLike } from "./redis";

let instance: Presence | null = null;
let pending: Promise<Presence> | null = null;

/**
 * Redis when `REDIS_URL` is set, in-process otherwise.
 *
 * The in-process driver is a development convenience only — it cannot see
 * connections held by another server process, so anything beyond a single
 * instance needs the real thing.
 */
export function presence(): Promise<Presence> {
  if (instance) return Promise.resolve(instance);
  if (pending) return pending;

  pending = build().then((built) => {
    instance = built;
    pending = null;
    return built;
  });

  return pending;
}

async function build(): Promise<Presence> {
  const url = process.env.REDIS_URL;
  if (!url) return createMemoryPresence();

  type ClientFactory = (options: { url: string }) => RedisLike & { connect(): Promise<unknown> };

  // The specifier is held in a variable on purpose: `redis` is an optional
  // peer, installed only where Redis actually runs, and a literal import would
  // make it a hard build-time dependency everywhere.
  const specifier = "redis";
  let createClient: ClientFactory;
  try {
    ({ createClient } = (await import(specifier)) as { createClient: ClientFactory });
  } catch {
    throw new Error(
      "REDIS_URL is set but the `redis` package is not installed. Run `npm install redis`, or unset REDIS_URL to use in-process presence.",
    );
  }

  const client = createClient({ url });
  await client.connect();
  return createRedisPresence(client);
}
