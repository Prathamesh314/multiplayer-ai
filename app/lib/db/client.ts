import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * One pool per process. Cached on globalThis because Next's dev server
 * re-evaluates modules on every change, and a fresh pool per edit exhausts
 * Postgres' connection limit within a few saves.
 */
const globalForDb = globalThis as unknown as { __maPool?: Pool };

export function pool(): Pool {
  if (globalForDb.__maPool) return globalForDb.__maPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Start the stack with `docker compose up -d` and copy .env.example to .env.local.",
    );
  }

  const created = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // A pool that emits 'error' with no listener takes the process down.
  created.on("error", (cause) => {
    console.error("postgres pool error", cause);
  });

  globalForDb.__maPool = created;
  return created;
}

export async function query<T extends QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T[]> {
  const result = await pool().query<T>(text, params);
  return result.rows;
}

/** First row, or null. For lookups that expect at most one. */
export async function queryOne<T extends QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs `work` inside a transaction, rolling back on any throw.
 *
 * Anything that writes to two tables and must not be observed half done — a
 * session plus its owner row, an invitation plus the membership it creates —
 * belongs in here.
 */
export async function transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => {});
    throw cause;
  } finally {
    client.release();
  }
}

/** Postgres unique-violation, for turning a race into a friendly message. */
export function isUniqueViolation(cause: unknown, constraint?: string): boolean {
  const error = cause as { code?: string; constraint?: string };
  if (error?.code !== "23505") return false;
  return constraint ? error.constraint === constraint : true;
}
