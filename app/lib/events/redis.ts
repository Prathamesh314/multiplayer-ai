import { channelFor, type EventBus, type EventHandler, type SessionEvent } from "./types";

/**
 * The publish and subscribe halves of a Redis client. They are separate
 * because a connection in subscriber mode cannot run ordinary commands — one
 * shared connection for both would deadlock the moment anything published.
 */
export type RedisPublisher = { publish(channel: string, message: string): Promise<unknown> };

export type RedisSubscriber = {
  on?(event: "ready", listener: () => void): unknown;
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
  const operations = new Map<string, Promise<unknown>>();
  const serialize = <T>(channel: string, action: () => Promise<T>): Promise<T> => {
    const next = (operations.get(channel) ?? Promise.resolve()).catch(() => {}).then(action);
    operations.set(channel, next);
    void next.finally(() => { if (operations.get(channel) === next) operations.delete(channel); }).catch(() => {});
    return next;
  };
  subscriber.on?.("ready", () => {
    // Redis pub/sub is a wakeup hint, never the durable record. Re-read after a
    // reconnect to recover any changes made while notifications were unavailable.
    for (const listeners of handlers.values()) for (const listener of [...listeners]) {
      try { listener({ type: "resync", at: Date.now() }); } catch { /* isolate readers */ }
    }
  });

  return {
    async publish(sessionId, event) {
      await publisher.publish(channelFor(sessionId), JSON.stringify(event));
    },

    async subscribe(sessionId, handler) {
      const channel = channelFor(sessionId);
      await serialize(channel, async () => {
        let local = handlers.get(channel);
        if (!local) {
          local = new Set([handler]); handlers.set(channel, local);
          try {
            await subscriber.subscribe(channel, message => {
              let event: SessionEvent;
              try { event = JSON.parse(message) as SessionEvent; } catch { return; }
              for (const listener of [...(handlers.get(channel) ?? [])]) {
                try { listener(event); } catch { /* isolate readers */ }
              }
            });
          } catch (cause) { handlers.delete(channel); throw cause; }
        } else local.add(handler);
      });
      let stopped = false;
      return async () => {
        if (stopped) return;
        stopped = true;
        await serialize(channel, async () => {
          const current = handlers.get(channel);
          if (!current) return;
          current.delete(handler);
          if (current.size) return;
          handlers.delete(channel);
          await subscriber.unsubscribe(channel).catch(() => {});
        });
      };
    },

    async close() {
      handlers.clear();
      await subscriber.quit().catch(() => {});
    },
  };
}
