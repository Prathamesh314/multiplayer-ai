import { createMemoryBus } from "./memory";
import { createRedisBus, type RedisPublisher, type RedisSubscriber } from "./redis";
import type { EventBus } from "./types";

export * from "./types";
export { createMemoryBus } from "./memory";
export { createRedisBus } from "./redis";

/**
 * Cached on globalThis, not just in module scope: Next's dev server re-evaluates
 * modules on edit, and a fresh bus per reload would leave existing SSE streams
 * subscribed to a bus nothing publishes to.
 */
const globalForBus = globalThis as unknown as { __maBus?: Promise<EventBus> };

export function events(): Promise<EventBus> {
  globalForBus.__maBus ??= build();
  return globalForBus.__maBus;
}

/**
 * Fan a role.changed out to a set of rooms at once — the affected user may be in
 * several (a project or org role change touches many rooms). Publishes are fired
 * concurrently; an empty set is a no-op. Callers compute the room set *before*
 * the mutation and call this *after* it commits, so recipients re-derive the new
 * role, not the old one.
 */
export async function publishRoleChanged(
  sessionIds: Iterable<string>,
  userId: string,
): Promise<void> {
  const ids = [...sessionIds];
  if (ids.length === 0) return;
  const bus = await events();
  const at = Date.now();
  await Promise.all(ids.map((id) => bus.publish(id, { type: "role.changed", userId, at })));
}

async function build(): Promise<EventBus> {
  const url = process.env.REDIS_URL;
  if (!url) return createMemoryBus();

  try {
    const { createClient } = (await import("redis")) as {
      createClient: (options: { url: string }) => {
        connect(): Promise<unknown>;
        duplicate(): {
          connect(): Promise<unknown>;
        } & RedisSubscriber;
      } & RedisPublisher;
    };

    const publisher = createClient({ url });
    await publisher.connect();

    // A duplicate rather than a second createClient: it inherits the same
    // options, so the two halves can never drift apart in configuration.
    const subscriber = publisher.duplicate();
    await subscriber.connect();

    return createRedisBus(publisher, subscriber);
  } catch (cause) {
    // A broken bus must not take the app down — losing live updates is far
    // better than losing the ability to open a session at all.
    console.error("falling back to in-process events:", cause);
    return createMemoryBus();
  }
}
