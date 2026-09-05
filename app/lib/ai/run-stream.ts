import type { AiRunEvent } from "./run-events";

/**
 * The worker→web bridge for one run's live output.
 *
 * When a run executes in a worker, its NDJSON events (`start`/`out`/`think`/…)
 * have to reach the driver's browser, which is connected to the *web* process.
 * The worker publishes each event to a per-run Redis channel and the run route
 * subscribes and forwards them down the response verbatim — so the client sees
 * exactly the same stream it did when the route spawned the agent itself.
 *
 * This is plain Redis pub/sub on the existing `node-redis` client, not BullMQ:
 * the queue moves *jobs*, this moves *tokens*, and keeping ioredis to the queue
 * alone (see `app/lib/queue`) is the boundary we're holding. Watcher fan-out
 * (`run.output`/`run.turn`/`run.finished`) still goes over the session event
 * bus as before; this channel is only the driver's private, full-fidelity feed,
 * which is why `think`/`act` ride it but never the bus.
 */
export type RunStreamHandler = (event: AiRunEvent) => void;

const channelForRun = (runId: string) => `run:${runId}:stream`;

type Publisher = { publish(channel: string, message: string): Promise<unknown> };
type Subscriber = {
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  quit(): Promise<unknown>;
};

type Bridge = {
  publisher: Publisher;
  subscriber: Subscriber;
  /** Per-channel local handlers, so one subscription fans out to many readers. */
  handlers: Map<string, Set<RunStreamHandler>>;
};

const globalForRunStream = globalThis as unknown as { __maRunStream?: Promise<Bridge> };

function bridge(): Promise<Bridge> {
  globalForRunStream.__maRunStream ??= build();
  return globalForRunStream.__maRunStream;
}

async function build(): Promise<Bridge> {
  const url = process.env.REDIS_URL;
  if (!url) {
    // Only ever reached in decoupled mode, which requires Redis; the inline
    // path never touches this module.
    throw new Error("REDIS_URL is required for the run-stream bridge.");
  }

  const specifier = "redis";
  const { createClient } = (await import(specifier)) as {
    createClient: (options: { url: string }) => {
      connect(): Promise<unknown>;
      duplicate(): { connect(): Promise<unknown> } & Subscriber;
    } & Publisher;
  };

  const publisher = createClient({ url });
  await publisher.connect();
  const subscriber = publisher.duplicate();
  await subscriber.connect();

  return { publisher, subscriber, handlers: new Map() };
}

/** Publish one event for `runId`. Called by the worker. */
export async function publishRunEvent(runId: string, event: AiRunEvent): Promise<void> {
  const { publisher } = await bridge();
  await publisher.publish(channelForRun(runId), JSON.stringify(event));
}

/**
 * Subscribe to `runId`'s events. Called by the route before it enqueues, so no
 * early event can be missed in the gap between enqueue and subscribe. Resolves
 * to an unsubscribe function; the last reader off a channel drops the Redis
 * subscription.
 */
export async function subscribeRunEvents(
  runId: string,
  handler: RunStreamHandler,
): Promise<() => Promise<void>> {
  const b = await bridge();
  const channel = channelForRun(runId);
  let local = b.handlers.get(channel);

  if (!local) {
    local = new Set();
    b.handlers.set(channel, local);
    await b.subscriber.subscribe(channel, (message) => {
      let event: AiRunEvent;
      try {
        event = JSON.parse(message) as AiRunEvent;
      } catch {
        return; // Corrupt or not ours; dropping it is the safe response.
      }
      for (const listener of [...(b.handlers.get(channel) ?? [])]) {
        try {
          listener(event);
        } catch {
          // One broken reader must not stop the others being fed.
        }
      }
    });
  }

  local.add(handler);

  return async () => {
    const current = b.handlers.get(channel);
    if (!current) return;
    current.delete(handler);
    if (current.size > 0) return;
    b.handlers.delete(channel);
    await b.subscriber.unsubscribe(channel).catch(() => {});
  };
}
