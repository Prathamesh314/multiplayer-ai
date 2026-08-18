/**
 * Presence is deliberately not in Postgres. A heartbeat every 20 seconds per
 * open tab is a write rate the primary database should never carry, and none of
 * it is worth recovering after a restart — an empty presence store is correct,
 * because nobody is connected.
 */

/** How often a connected tab reports in. */
export const HEARTBEAT_MS = 20_000;

/** How long a heartbeat counts for. Two missed beats plus slack. */
export const TTL_MS = 45_000;

export type Connection = {
  userId: string;
  /** The workspace the tab is looking at, if any. */
  sessionId: string | null;
  orgId: string | null;
  device?: string;
};

export type Presence = {
  /** Records or refreshes a connection. Called every `HEARTBEAT_MS`. */
  heartbeat(connectionId: string, connection: Connection): Promise<void>;

  /**
   * Drops a connection immediately. An optimisation, not a requirement — a
   * force-quit browser never sends one and the TTL window cleans up anyway.
   */
  disconnect(connectionId: string): Promise<void>;

  /** User ids with a live heartbeat in this session. */
  onlineInSession(sessionId: string): Promise<string[]>;

  /** User ids with a live heartbeat anywhere in this org. */
  onlineInOrg(orgId: string): Promise<string[]>;

  isOnline(userId: string): Promise<boolean>;

  close(): Promise<void>;
};
