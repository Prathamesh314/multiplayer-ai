import { channelFor, type EventBus, type EventHandler, type SessionEvent } from "./types";

/**
 * The publish and subscribe halves of a Redis client. They are separate
 * because a connection in subscriber mode cannot run ordinary commands — one
 * shared connection for both would deadlock the moment anything published.
 */
export type RedisPublisher = { publish(channel: string, message: string): Promise<unknown> };

export type RedisSubscriber = {
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
};

/**
 * Fan-out across every server process.
 *
 * One subscriber connection carries all channels, reference counted: a session
 * with forty watchers on this instance still costs one Redis subscription, and
 * the channel is dropped only when the last local watcher goes.
 */
export function createRedisBus(publisher: RedisPublisher, subscriber: RedisSubscriber): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();

  return {
    async publish(sessionId, event) {
      await publisher.publish(channelFor(sessionId), JSON.stringify(event));
    },

    async subscribe(sessionId, handler) {
      const channel = channelFor(sessionId);
      let local = handlers.get(channel);

      if (!local) {
        local = new Set();
        handlers.set(channel, local);
        await subscriber.subscribe(channel, (message) => {
          let event: SessionEvent;
          try {
            event = JSON.parse(message) as SessionEvent;
          } catch {
            return; // Not ours, or corrupt. Dropping it is the safe response.
          }
          for (const listener of [...(handlers.get(channel) ?? [])]) {
            try {
              listener(event);
            } catch {
              // One broken subscriber must not stop the others being told.
            }
          }
        });
      }

      local.add(handler);

      return async () => {
        const current = handlers.get(channel);
        if (!current) return;
        current.delete(handler);
        if (current.size > 0) return;

        handlers.delete(channel);
        await subscriber.unsubscribe(channel).catch(() => {});
      };
    },

    async close() {
      handlers.clear();
      await subscriber.quit().catch(() => {});
    },
  };
}
