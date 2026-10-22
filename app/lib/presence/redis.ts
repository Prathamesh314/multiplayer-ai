import { TTL_MS, type Presence } from "./types";

/**
 * The subset of a Redis client this driver uses. Declared structurally rather
 * than imported so the `redis` package is only needed where Redis actually
 * runs, and so the command sequence can be tested against a fake.
 */
export type RedisLike = {
  hSet(key: string, value: Record<string, string>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
  del(key: string): Promise<unknown>;
  zAdd(key: string, member: { score: number; value: string }): Promise<unknown>;
  zRem(key: string, member: string): Promise<unknown>;
  zRangeByScore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<unknown>;
  quit(): Promise<unknown>;
};

const connKey = (id: string) => `presence:conn:${id}`;
const userKey = (id: string) => `presence:user:${id}`;
const sessionKey = (id: string) => `presence:session:${id}`;
const orgKey = (id: string) => `presence:org:${id}`;
const runKey = (id: string) => `presence:run:${id}`;

/**
 * Sorted sets, not sets, and the reason is not style: Redis expires whole keys
 * and never individual set members, so a plain SET of online users has no way
 * to drop one person when their laptop sleeps.
 *
 * Scoring by heartbeat timestamp gives expiry on read and cheap reaping, which
 * means correctness never depends on a sweeper having run.
 */
export function createRedisPresence(client: RedisLike, now: () => number = Date.now): Presence {
  /** Members inside the TTL window, reaping the stale ones as a side effect. */
  async function live(key: string): Promise<string[]> {
    const cutoff = now() - TTL_MS;
    const alive = await client.zRangeByScore(key, `(${cutoff}`, "+inf");
    // Best-effort trim so idle keys do not grow without bound.
    await client.zRemRangeByScore(key, 0, cutoff);
    return alive;
  }

  /** Drop someone from a chat unless another live tab of theirs is still on it. */
  async function leaveRun(userId: string, runId: string, exceptConnection: string) {
    for (const id of await live(userKey(userId))) {
      if (id === exceptConnection) continue;
      if ((await client.hGetAll(connKey(id)))?.run_id === runId) return;
    }
    await client.zRem(runKey(runId), userId);
  }

  return {
    async heartbeat(connectionId, connection) {
      const at = now();
      const key = connKey(connectionId);
      const previous = await client.hGetAll(key);
      const known = !!previous?.user_id;
      const runId = connection.runId ?? "";
      const changed = !known || (previous.session_id ?? "") !== (connection.sessionId ?? "") || (previous.run_id ?? "") !== runId;
      if (known && previous.run_id && previous.run_id !== runId) await leaveRun(previous.user_id, previous.run_id, connectionId);

      await client.hSet(key, {
        user_id: connection.userId,
        session_id: connection.sessionId ?? "",
        org_id: connection.orgId ?? "",
        run_id: runId,
        device: connection.device ?? "",
      });
      await client.expire(key, Math.ceil(TTL_MS / 1000));

      // Connections are scored per user so multiple tabs and devices resolve
      // to one person being online.
      await client.zAdd(userKey(connection.userId), { score: at, value: connectionId });
      if (connection.sessionId) {
        await client.zAdd(sessionKey(connection.sessionId), { score: at, value: connection.userId });
      }
      if (connection.orgId) {
        await client.zAdd(orgKey(connection.orgId), { score: at, value: connection.userId });
      }
      if (runId) await client.zAdd(runKey(runId), { score: at, value: connection.userId });
      const sessionIds = [...new Set([known ? previous.session_id : "", connection.sessionId ?? ""].filter(Boolean))];
      return { changed, sessionIds: changed ? sessionIds : [] };
    },

    async disconnect(connectionId) {
      const key = connKey(connectionId);
      const stored = await client.hGetAll(key);
      const userId = stored?.user_id;
      if (!userId) return { changed: false, sessionIds: [] };

      await client.del(key);
      await client.zRem(userKey(userId), connectionId);
      if (stored.run_id) await leaveRun(userId, stored.run_id, connectionId);
      const sessionIds = stored.session_id ? [stored.session_id] : [];

      // Still present in another tab: leave the session and org sets alone.
      if ((await live(userKey(userId))).length > 0) return { changed: true, sessionIds };

      if (stored.session_id) await client.zRem(sessionKey(stored.session_id), userId);
      if (stored.org_id) await client.zRem(orgKey(stored.org_id), userId);
      return { changed: true, sessionIds };
    },

    async onlineInRun(runId) {
      return live(runKey(runId));
    },

    async onlineInSession(sessionId) {
      return live(sessionKey(sessionId));
    },

    async onlineInOrg(orgId) {
      return live(orgKey(orgId));
    },

    async isOnline(userId) {
      return (await live(userKey(userId))).length > 0;
    },

    async close() {
      await client.quit();
    },
  };
}
