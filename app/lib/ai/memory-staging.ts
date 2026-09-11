/*
 * The memory staging buffer.
 *
 * When a run finishes we already `remember` the exchange into the sidecar's
 * working memory — that, not this buffer, is what a later `sleep` consolidates.
 * This buffer is the *app-side* record of what has been ingested for a room
 * since its last consolidation: it makes the ingestion pipeline observable and
 * lets the consolidation worker skip a no-op sleep when nothing new landed. It
 * is deliberately lightweight and disposable — losing it costs a log line, not
 * a memory (the durable copy is in the sidecar).
 *
 * node-redis, to stay consistent with the event bus and lock; ioredis is kept
 * to the queue module alone.
 */

/** Most recent exchanges kept per room; older ones are trimmed away. */
const MAX_STAGED = 100;
/** A room's buffer self-expires if consolidation never runs, so it can't leak. */
const STAGE_TTL_SECONDS = 24 * 60 * 60;

const keyFor = (sessionId: string) => `memory:stage:${sessionId}`;

export type StagedExchange = {
  prompt: string;
  reply: string;
  changed: boolean;
  at: number;
};

/** Chainable so `multi().lRange(...).del(...).exec()` types through. */
type Multi = {
  lRange(key: string, start: number, stop: number): Multi;
  del(key: string): Multi;
  exec(): Promise<unknown[]>;
};

type Client = {
  rPush(key: string, value: string): Promise<number>;
  lTrim(key: string, start: number, stop: number): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  lRange(key: string, start: number, stop: number): Promise<string[]>;
  multi(): Multi;
};

const globalForStage = globalThis as unknown as { __maStageRedis?: Promise<Client | null> };

function client(): Promise<Client | null> {
  globalForStage.__maStageRedis ??= build();
  return globalForStage.__maStageRedis;
}

async function build(): Promise<Client | null> {
  const url = process.env.REDIS_URL;
  if (!url) return null; // No Redis → staging is a no-op, like presence.
  try {
      const { createClient } = (await import("redis")) as {
      createClient: (options: { url: string }) => { connect(): Promise<unknown> } & Client;
    };
    const c = createClient({ url });
    await c.connect();
    return c;
  } catch {
    // Staging is best-effort; a broken connection must not break ingest.
    return null;
  }
}

/** Append one exchange to a room's buffer. Best-effort; failures are swallowed. */
export async function stageExchange(sessionId: string, record: StagedExchange): Promise<void> {
  const c = await client();
  if (!c) return;
  const key = keyFor(sessionId);
  try {
    await c.rPush(key, JSON.stringify(record));
    // Keep only the most recent MAX_STAGED, and refresh the TTL on activity.
    await c.lTrim(key, -MAX_STAGED, -1);
    await c.expire(key, STAGE_TTL_SECONDS);
  } catch {
    // A dropped record just means one fewer line in the observability log.
  }
}

/**
 * Atomically read and clear a room's buffer. MULTI so an exchange pushed between
 * the read and the delete is not lost — it stays for the next consolidation.
 * Returns the drained records (newest last) for logging / no-op detection.
 */
export async function drainStaged(sessionId: string): Promise<StagedExchange[]> {
  const c = await client();
  if (!c) return [];
  const key = keyFor(sessionId);
  try {
    const [rows] = (await c.multi().lRange(key, 0, -1).del(key).exec()) as [string[], unknown];
    if (!Array.isArray(rows)) return [];
    return rows
      .map((row) => {
        try {
          return JSON.parse(row) as StagedExchange;
        } catch {
          return null;
        }
      })
      .filter((r): r is StagedExchange => r !== null);
  } catch {
    return [];
  }
}
