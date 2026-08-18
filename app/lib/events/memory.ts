import type { EventBus, EventHandler, SessionEvent } from "./types";

/**
 * Single-process fan-out for development.
 *
 * Correct only while one server process holds every connection — two instances
 * behind a load balancer would each broadcast to their own clients and nobody
 * else's, which is exactly what the Redis driver exists to fix.
 */
export function createMemoryBus(): EventBus {
  const channels = new Map<string, Set<EventHandler>>();

  return {
    async publish(sessionId, event) {
      const handlers = channels.get(sessionId);
      if (!handlers) return;
      // Copied before iterating: a handler that unsubscribes itself would
      // otherwise mutate the set mid-loop.
      for (const handler of [...handlers]) {
        try {
          handler(event);
        } catch {
          // One broken subscriber must not stop the others being told.
        }
      }
    },

    async subscribe(sessionId, handler) {
      let handlers = channels.get(sessionId);
      if (!handlers) {
        handlers = new Set();
        channels.set(sessionId, handlers);
      }
      handlers.add(handler);

      return async () => {
        handlers!.delete(handler);
        if (handlers!.size === 0) channels.delete(sessionId);
      };
    },

    async close() {
      channels.clear();
    },
  };
}

export type { SessionEvent };
