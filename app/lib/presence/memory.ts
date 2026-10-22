import { TTL_MS, type Connection, type Presence } from "./types";

/**
 * Single-process presence for development, where standing up Redis to see two
 * avatars is not a reasonable ask.
 *
 * It reproduces the Redis driver's semantics exactly — timestamp-scored sets
 * filtered on read — so behaviour does not change when the driver does. It is
 * not a production option: nothing is shared between server processes.
 */
export function createMemoryPresence(now: () => number = Date.now): Presence {
  /** Mirrors a Redis sorted set: member → last heartbeat. */
  type Scored = Map<string, number>;

  const connections = new Map<string, Connection & { at: number }>();
  const byUser = new Map<string, Scored>();
  const bySession = new Map<string, Scored>();
  const byOrg = new Map<string, Scored>();
  const byRun = new Map<string, Scored>();

  function bucket(map: Map<string, Scored>, key: string): Scored {
    let scored = map.get(key);
    if (!scored) {
      scored = new Map();
      map.set(key, scored);
    }
    return scored;
  }

  /** Members whose score is inside the window — the ZRANGEBYSCORE equivalent. */
  function live(map: Map<string, Scored>, key: string): string[] {
    const scored = map.get(key);
    if (!scored) return [];

    const cutoff = now() - TTL_MS;
    const alive: string[] = [];
    for (const [member, score] of scored) {
      if (score > cutoff) alive.push(member);
      // Reaping on read is what makes correctness independent of any sweeper.
      else scored.delete(member);
    }
    if (scored.size === 0) map.delete(key);
    return alive;
  }

  /** Drop someone from a chat unless another live tab of theirs is still on it. */
  function leaveRun(userId: string, runId: string, exceptConnection: string) {
    const stillThere = live(byUser, userId).some((id) => id !== exceptConnection && connections.get(id)?.runId === runId);
    if (!stillThere) {
      byRun.get(runId)?.delete(userId);
      if (byRun.get(runId)?.size === 0) byRun.delete(runId);
    }
  }

  return {
    async heartbeat(connectionId, connection) {
      const at = now();
      const previous = connections.get(connectionId);
      const runId = connection.runId ?? null;
      const changed = !previous || previous.sessionId !== connection.sessionId || (previous.runId ?? null) !== runId;
      if (previous?.runId && previous.runId !== runId) leaveRun(previous.userId, previous.runId, connectionId);
      connections.set(connectionId, { ...connection, runId, at });

      bucket(byUser, connection.userId).set(connectionId, at);
      if (connection.sessionId) bucket(bySession, connection.sessionId).set(connection.userId, at);
      if (connection.orgId) bucket(byOrg, connection.orgId).set(connection.userId, at);
      if (runId) bucket(byRun, runId).set(connection.userId, at);
      const sessionIds = [...new Set([previous?.sessionId, connection.sessionId].filter((id): id is string => !!id))];
      return { changed, sessionIds: changed ? sessionIds : [] };
    },

    async disconnect(connectionId) {
      const connection = connections.get(connectionId);
      if (!connection) return { changed: false, sessionIds: [] };
      connections.delete(connectionId);

      const userConnections = byUser.get(connection.userId);
      userConnections?.delete(connectionId);
      if (connection.runId) leaveRun(connection.userId, connection.runId, connectionId);
      const sessionIds = connection.sessionId ? [connection.sessionId] : [];

      // Another tab may still be open. Only the last one going marks the
      // person away — otherwise closing one tab hides someone who is still
      // working in the other.
      if (live(byUser, connection.userId).length > 0) return { changed: true, sessionIds };

      if (connection.sessionId) bySession.get(connection.sessionId)?.delete(connection.userId);
      if (connection.orgId) byOrg.get(connection.orgId)?.delete(connection.userId);
      return { changed: true, sessionIds };
    },

    async onlineInRun(runId) {
      return live(byRun, runId);
    },

    async onlineInSession(sessionId) {
      return live(bySession, sessionId);
    },

    async onlineInOrg(orgId) {
      return live(byOrg, orgId);
    },

    async isOnline(userId) {
      return live(byUser, userId).length > 0;
    },

    async close() {
      connections.clear();
      byUser.clear();
      bySession.clear();
      byOrg.clear();
      byRun.clear();
    },
  };
}
