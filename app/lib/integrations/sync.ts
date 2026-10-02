import { query, transaction } from "../db/client";
import { adapterFor } from "./providers";
import { saveSourceMessages } from "./store";
import { IntegrationError, type Connection } from "./types";

/** Claim one channel at a time, with a database-backed workspace cooldown.
 * Slack history is capped at one request/minute for non-marketplace apps;
 * replicas must share that budget. Live traffic arrives through events. */
export async function syncNextChannel() {
  const work = await transaction(async (tx) => {
    const connection = (
      await tx.query<Connection>(`SELECT c.* FROM context_connections c WHERE EXISTS
      (SELECT 1 FROM context_channels ch WHERE ch.connection_id=c.id AND ch.next_sync_at<=now())
      AND NOT EXISTS (SELECT 1 FROM context_sync_budgets b WHERE b.provider=c.provider AND b.external_id=c.external_id AND b.next_request_at>now())
      ORDER BY (SELECT min(ch.next_sync_at) FROM context_channels ch WHERE ch.connection_id=c.id),c.id
      FOR UPDATE SKIP LOCKED LIMIT 1`)
    ).rows[0];
    if (!connection) return null;
    // Serialize all project connections for the same remote workspace without
    // retaining a DB connection while waiting on the network.
    const gate = await tx.query(
      `INSERT INTO context_sync_budgets(provider,external_id,next_request_at)
      VALUES ($1,$2,now()+make_interval(secs=>$3)) ON CONFLICT(provider,external_id) DO UPDATE SET next_request_at=excluded.next_request_at
      WHERE context_sync_budgets.next_request_at<=now() RETURNING provider`,
      [
        connection.provider,
        connection.external_id,
        connection.provider === "slack" ? 65 : 2,
      ],
    );
    if (!gate.rows.length) return null;
    const channel = (
      await tx.query<{
        channel_id: string;
        name: string;
        url: string;
        access_version: string;
      }>(
        `SELECT channel_id,name,url,access_version FROM context_channels WHERE connection_id=$1 AND next_sync_at<=now() ORDER BY next_sync_at FOR UPDATE SKIP LOCKED LIMIT 1`,
        [connection.id],
      )
    ).rows[0];
    if (!channel) return null;
    await tx.query(
      `UPDATE context_channels SET next_sync_at=now()+interval '10 minutes' WHERE connection_id=$1 AND channel_id=$2`,
      [connection.id, channel.channel_id],
    );
    return { connection, channel };
  });
  if (!work) return false;
  const { connection, channel } = work;
  const startedAt = new Date();
  try {
    const snapshot = await adapterFor(connection.provider).history(connection, {
      id: channel.channel_id,
      name: channel.name,
      url: channel.url,
    });
    const { messages } = snapshot;
    if (
      !(await saveSourceMessages(
        connection.id,
        channel.channel_id,
        messages,
        true,
        channel.access_version,
      ))
    )
      return true;
    await query(
      "UPDATE context_channels SET name=$3,url=$4 WHERE connection_id=$1 AND channel_id=$2",
      [
        connection.id,
        channel.channel_id,
        snapshot.channel.name,
        snapshot.channel.url,
      ],
    );
    // Reconcile deletions missed during downtime only inside a complete recent
    // top-level history window. Slack thread replies are not in that response.
    {
      const oldest = messages.length
        ? messages.reduce(
            (min, m) =>
              Date.parse(m.sentAt) < Date.parse(min) ? m.sentAt : min,
            messages[0].sentAt,
          )
        : new Date(0).toISOString();
      await query(
        `UPDATE context_messages SET deleted=true,body='' WHERE connection_id=$1 AND channel_id=$2
        AND sent_at>=$3 AND sent_at<=$4 AND (thread_id IS NULL OR $6='discord') AND NOT (message_id=ANY($5::text[]))`,
        [
          connection.id,
          channel.channel_id,
          oldest,
          startedAt,
          messages.map((m) => m.id),
          connection.provider,
        ],
      );
    }
  } catch (error) {
    const retry = error instanceof IntegrationError ? error.retryAfter : 60;
    if (error instanceof IntegrationError && error.status === 429)
      await query(
        `UPDATE context_sync_budgets SET next_request_at=greatest(next_request_at,now()+make_interval(secs=>$3)) WHERE provider=$1 AND external_id=$2`,
        [connection.provider, connection.external_id, retry],
      );
    await query(
      `UPDATE context_channels SET verified_at=NULL,error=$3,next_sync_at=now()+make_interval(secs=>$4)
      WHERE connection_id=$1 AND channel_id=$2 AND access_version=$5`,
      [
        connection.id,
        channel.channel_id,
        error instanceof IntegrationError
          ? error.message
          : "Sync is temporarily unavailable. Retrying.",
        Math.max(600, retry),
        channel.access_version,
      ],
    );
    await saveSourceMessages(connection.id, channel.channel_id, []);
  }
  return true;
}
