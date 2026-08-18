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

  return {
    async heartbeat(connectionId, connection) {
      const at = now();
      connections.set(connectionId, { ...connection, at });

      bucket(byUser, connection.userId).set(connectionId, at);
      if (connection.sessionId) bucket(bySession, connection.sessionId).set(connection.userId, at);
      if (connection.orgId) bucket(byOrg, connection.orgId).set(connection.userId, at);
    },

    async disconnect(connectionId) {
      const connection = connections.get(connectionId);
      if (!connection) return;
      connections.delete(connectionId);

      const userConnections = byUser.get(connection.userId);
      userConnections?.delete(connectionId);

      // Another tab may still be open. Only the last one going marks the
      // person away — otherwise closing one tab hides someone who is still
      // working in the other.
      if (live(byUser, connection.userId).length > 0) return;

      if (connection.sessionId) bySession.get(connection.sessionId)?.delete(connection.userId);
      if (connection.orgId) byOrg.get(connection.orgId)?.delete(connection.userId);
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
    },
  };
}
