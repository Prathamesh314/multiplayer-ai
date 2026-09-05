import { randomBytes } from "node:crypto";

/**
 * A mutual-exclusion lock keyed by session id, used to serialise git operations
 * on one session's working copy.
 *
 * Git serialises on `index.lock`, so two concurrent commits in the same working
 * copy make one of them fail (see the note on `withRepoLock` in `repo.ts`). A
 * per-process `Map` mutex is enough *while every writer lives in one process*.
 * Once agent runs move to a separate worker (see ARCHITECTURE.md's "run
 * execution is server-local" boundary), a human's debounced file-save in the
 * web process and the agent's commit in the worker process are two processes
 * racing for the same `index.lock` — an in-process mutex on either side cannot
 * see the other. The Redis driver below is that missing cross-process arbiter;
 * the in-memory one stays the correct choice for single-process development.
 *
 * The two drivers are interchangeable behind this interface, exactly like the
 * event bus (`app/lib/events`) and presence (`app/lib/presence`).
 */
export interface RepoLock {
  /** Runs `task` while holding the lock for `id`; releases it however task settles. */
  withLock<T>(id: string, task: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Single-process fan-in for development.
 *
 * This is the existing `withRepoLock` behaviour, lifted verbatim: a promise
 * chain per id so callers queue rather than race, and a failure settles the
 * chain rather than poisoning it. Correct only while one process holds every
 * writer — which is exactly the condition the Redis driver exists to drop.
 */
export function createMemoryLock(): RepoLock {
  const chains = new Map<string, Promise<unknown>>();

  return {
    async withLock(id, task) {
      const previous = chains.get(id) ?? Promise.resolve();
      const result = previous.then(task, task);
      // The next caller waits on the settled form so one rejection cannot break
      // the queue; this caller still sees the real outcome through `result`.
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      chains.set(id, settled);
      try {
        return await result;
      } finally {
        if (chains.get(id) === settled) chains.delete(id);
      }
    },

    async close() {
      chains.clear();
    },
  };
}

/**
 * The slice of a `node-redis` client the Redis lock needs. Kept to two methods
 * so a test can supply a fake with real `SET NX PX` / `EVAL` semantics, the way
 * the presence and event-bus suites already do.
 */
export type LockRedis = {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<string | null>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

export type RedisLockOptions = {
  /** Lock lifetime if the holder vanishes; renewed underneath a running task. */
  ttlMs?: number;
  /** How long to keep retrying acquisition before giving up. */
  acquireTimeoutMs?: number;
  /** Base gap between acquisition attempts (a little jitter is added). */
  retryDelayMs?: number;
  /** Namespace for the lock keys; overridable so tests never collide. */
  prefix?: string;
  /** Injectable sleep, so a test can tie backoff to its fake clock. */
  delay?: (ms: number) => Promise<void>;
};

// Release and renew are compare-and-act: touch the key only while we still own
// it, so a lock that already expired and was retaken by someone else is never
// deleted or extended out from under them. Done in Lua for atomicity.
const RELEASE = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

const RENEW = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cross-process lock over Redis.
 *
 * `SET key token NX PX ttl` is the classic single-instance mutex: the first
 * caller to set the key owns it, everyone else spins until it clears or its TTL
 * lapses. The TTL is the safety valve — a worker that is SIGKILLed mid-run
 * cannot wedge the session forever — and a watchdog extends it every ttl/3
 * while the task is genuinely still running, so a slow-but-alive operation (a
 * cold `ensureWork` clone of a large repo) is not cut loose while it works.
 *
 * This is deliberately a single-instance lock, not Redlock: one Redis is the
 * same Redis the event bus and presence already depend on, and losing that
 * Redis degrades far more than this lock.
 */
export function createRedisLock(redis: LockRedis, options: RedisLockOptions = {}): RepoLock {
  const ttlMs = options.ttlMs ?? 30_000;
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 60_000;
  const retryDelayMs = options.retryDelayMs ?? 100;
  const prefix = options.prefix ?? "repo-lock";
  const delay = options.delay ?? sleep;

  const keyFor = (id: string) => `${prefix}:${id}`;

  const acquire = async (key: string, token: string, deadline: number): Promise<void> => {
    // A first attempt with no wait, then spin until the deadline. The gap has a
    // little jitter so a thundering herd of waiters does not resynchronise on
    // every retry and hammer the same instant.
    for (;;) {
      const ok = await redis.set(key, token, { NX: true, PX: ttlMs });
      if (ok) return;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock ${key} after ${acquireTimeoutMs}ms.`);
      }
      await delay(retryDelayMs + Math.floor(Math.random() * retryDelayMs));
    }
  };

  const release = async (key: string, token: string): Promise<void> => {
    await redis.eval(RELEASE, { keys: [key], arguments: [token] }).catch(() => {
      // A failed release is not fatal: the TTL will clear the key regardless.
      // Better to let the task's own result surface than to mask it with this.
    });
  };

  return {
    async withLock(id, task) {
      const key = keyFor(id);
      // A fresh token per acquisition is what makes release/renew safe: they
      // only ever act on a key that still carries *our* token.
      const token = randomBytes(16).toString("hex");
      await acquire(key, token, Date.now() + acquireTimeoutMs);

      // Keep the lock alive under a long-but-live task. Cleared in `finally`
      // before release, so it can never race the unlock. `unref` so a lingering
      // timer never keeps the process up on its own.
      const watchdog = setInterval(() => {
        void redis
          .eval(RENEW, { keys: [key], arguments: [token, String(ttlMs)] })
          .catch(() => {});
      }, Math.max(1, Math.floor(ttlMs / 3)));
      (watchdog as { unref?: () => void }).unref?.();

      try {
        return await task();
      } finally {
        clearInterval(watchdog);
        await release(key, token);
      }
    },

    async close() {
      // The client's lifecycle is owned by whoever built it (see `build` below).
    },
  };
}

/**
 * The process-wide repo lock, chosen the way the event bus is
 * (`app/lib/events/index.ts`): Redis when `REDIS_URL` is set — the only correct
 * choice once web and worker are separate processes — and an in-process mutex
 * otherwise, which is right for single-process development.
 *
 * Cached on `globalThis` for the same reason the bus is: Next re-evaluates
 * modules on edit in dev, and a fresh lock per reload would let two "held"
 * locks that are really the same session run concurrently.
 */
const globalForLock = globalThis as unknown as { __maRepoLock?: Promise<RepoLock> };

export function repoLock(): Promise<RepoLock> {
  globalForLock.__maRepoLock ??= build();
  return globalForLock.__maRepoLock;
}

async function build(): Promise<RepoLock> {
  const url = process.env.REDIS_URL;
  if (!url) return createMemoryLock();

  const specifier = "redis";
  try {
    const { createClient } = (await import(specifier)) as {
      createClient: (options: { url: string }) => {
        connect(): Promise<unknown>;
      } & LockRedis;
    };

    // An ordinary command connection — not a subscriber, so `set`/`eval` run
    // normally. Separate from the bus's connections on purpose: a lock stall
    // must never wedge event delivery, or vice versa.
    const client = createClient({ url });
    await client.connect();
    return createRedisLock(client);
  } catch (cause) {
    // Unlike the event bus, a missing cross-process lock is not safe to paper
    // over: falling back to an in-process mutex here would silently drop the
    // guarantee that a worker commit and a web save can't collide. So this
    // throws rather than degrading — the decoupled mode requires a real Redis.
    throw new Error(
      `REDIS_URL is set but the repo lock could not connect to Redis: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}
