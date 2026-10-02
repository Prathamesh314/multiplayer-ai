import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { query, queryOne, transaction } from "../db/client";
import { seal } from "./config";
import {
  IntegrationError,
  type Connection,
  type SourceChannel,
  type SourceMessage,
  type TeamProvider,
} from "./types";

/** Live membership checks also apply to retrieval: room invitations do not
 * implicitly grant project-wide access to external channel messages. */
export const PROJECT_ACCESS_SQL = `EXISTS (
  SELECT 1 FROM projects p JOIN orgs o ON o.id=p.org_id
    JOIN org_members om ON om.org_id=p.org_id AND om.user_id=$2
    JOIN users u ON u.id=om.user_id
    LEFT JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2 AND pm.removed_at IS NULL
  WHERE p.id=c.project_id AND p.archived_at IS NULL AND o.deleted_at IS NULL
    AND om.status='active' AND u.deleted_at IS NULL
    AND (pm.role IS NOT NULL OR om.role IN ('owner','admin')))`;

async function manager(tx: PoolClient, projectId: string, userId: string) {
  // Lock the membership rows through the write, so a stale HTTP/OAuth request
  // cannot commit a new connection after access has already been revoked.
  const member = (
    await tx.query<{ org_role: string }>(
      `SELECT om.role AS org_role FROM projects p
    JOIN orgs o ON o.id=p.org_id JOIN org_members om ON om.org_id=p.org_id AND om.user_id=$2
    JOIN users u ON u.id=om.user_id WHERE p.id=$1 AND p.archived_at IS NULL AND o.deleted_at IS NULL
      AND om.status='active' AND u.deleted_at IS NULL FOR SHARE OF p,om,u`,
      [projectId, userId],
    )
  ).rows[0];
  const explicit = (
    await tx.query<{ role: string }>(
      `SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL FOR SHARE`,
      [projectId, userId],
    )
  ).rows[0];
  if (
    !member ||
    (explicit?.role ??
      (["owner", "admin"].includes(member.org_role) ? "manager" : null)) !==
      "manager"
  ) {
    throw new IntegrationError(
      "Only a project manager can change connections.",
      403,
    );
  }
}
export async function createOAuthState(
  projectId: string,
  userId: string,
  provider: TeamProvider,
) {
  const state = randomBytes(32).toString("base64url");
  await transaction(async (tx) => {
    await manager(tx, projectId, userId);
    await tx.query("DELETE FROM context_oauth_states WHERE expires_at<now()");
    await tx.query(
      "INSERT INTO context_oauth_states(digest,project_id,user_id,provider) VALUES ($1,$2,$3,$4)",
      [
        createHash("sha256").update(state).digest(),
        projectId,
        userId,
        provider,
      ],
    );
  });
  return state;
}
export async function consumeOAuthState(
  state: string,
  userId: string,
  provider: TeamProvider,
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state))
    throw new IntegrationError(
      "This connection request is invalid or expired. Start again.",
    );
  const row = await queryOne<{ project_id: string }>(
    `DELETE FROM context_oauth_states WHERE digest=$1 AND user_id=$2 AND provider=$3 AND expires_at>now() RETURNING project_id`,
    [createHash("sha256").update(state).digest(), userId, provider],
  );
  if (!row)
    throw new IntegrationError(
      "This connection request is invalid or expired. Start again.",
    );
  return row.project_id;
}
export async function connectProject(
  projectId: string,
  userId: string,
  provider: TeamProvider,
  source: { externalId: string; name: string; token: string },
) {
  return transaction(async (tx) => {
    await manager(tx, projectId, userId);
    // A reconnect is an explicit reset. Old channels never carry over to a
    // different external workspace, even when channel identifiers collide.
    await tx.query(
      "DELETE FROM context_connections WHERE project_id=$1 AND provider=$2",
      [projectId, provider],
    );
    return (
      await tx.query<Connection>(
        `INSERT INTO context_connections(project_id,provider,external_id,name,credential,created_by)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          projectId,
          provider,
          source.externalId,
          source.name.slice(0, 200),
          seal(source.token, `${provider}:${projectId}`),
          userId,
        ],
      )
    ).rows[0];
  });
}
export const connectionFor = (projectId: string, provider: TeamProvider) =>
  queryOne<Connection>(
    "SELECT * FROM context_connections WHERE project_id=$1 AND provider=$2",
    [projectId, provider],
  );
export async function connectionSummary(projectId: string) {
  const connections = await query<{
    id: string;
    provider: TeamProvider;
    name: string;
  }>(
    "SELECT id,provider,name FROM context_connections WHERE project_id=$1 ORDER BY provider",
    [projectId],
  );
  return Promise.all(
    connections.map(async (connection) => ({
      ...connection,
      channels: await query(
        `SELECT channel_id AS id,name,url,verified_at AS "verifiedAt",synced_at AS "syncedAt",error,
      (SELECT count(*)::int FROM context_messages m WHERE m.connection_id=ch.connection_id AND m.channel_id=ch.channel_id AND NOT m.deleted) AS "messageCount"
      FROM context_channels ch WHERE connection_id=$1 ORDER BY name`,
        [connection.id],
      ),
    })),
  );
}
export async function selectChannels(
  projectId: string,
  userId: string,
  connectionId: string,
  channels: SourceChannel[],
) {
  if (
    channels.length > 10 ||
    new Set(channels.map((c) => c.id)).size !== channels.length
  )
    throw new IntegrationError("Select at most 10 different channels.");
  await transaction(async (tx) => {
    await manager(tx, projectId, userId);
    const found = await tx.query(
      "SELECT id FROM context_connections WHERE id=$1 AND project_id=$2 FOR UPDATE",
      [connectionId, projectId],
    );
    if (!found.rows.length)
      throw new IntegrationError(
        "Connection not found. Refresh and try again.",
        404,
      );
    await tx.query(
      "DELETE FROM context_channels WHERE connection_id=$1 AND NOT (channel_id=ANY($2::text[]))",
      [connectionId, channels.map((c) => c.id)],
    );
    for (const channel of channels)
      await tx.query(
        `INSERT INTO context_channels(connection_id,channel_id,name,url) VALUES ($1,$2,$3,$4)
      ON CONFLICT(connection_id,channel_id) DO UPDATE SET name=excluded.name,url=excluded.url`,
        [connectionId, channel.id, channel.name.slice(0, 200), channel.url],
      );
  });
}
export async function disconnectProject(
  projectId: string,
  userId: string,
  provider: TeamProvider,
) {
  await transaction(async (tx) => {
    await manager(tx, projectId, userId);
    await tx.query(
      "DELETE FROM context_connections WHERE project_id=$1 AND provider=$2",
      [projectId, provider],
    );
  });
}
export async function saveSourceMessages(
  connectionId: string,
  channelId: string,
  messages: SourceMessage[],
  verified = false,
  expectedAccessVersion?: string,
) {
  return transaction(async (tx) => {
    // Same lock order as selection/disconnect; missing/deleted channels cannot
    // be recreated by a late event, history fetch or job from an old connection.
    if (
      !(
        await tx.query(
          "SELECT id FROM context_connections WHERE id=$1 FOR SHARE",
          [connectionId],
        )
      ).rows.length
    )
      return false;
    const channel = (
      await tx.query<{ access_version: string }>(
        "SELECT access_version FROM context_channels WHERE connection_id=$1 AND channel_id=$2 FOR UPDATE",
        [connectionId, channelId],
      )
    ).rows[0];
    if (
      !channel ||
      (expectedAccessVersion !== undefined &&
        String(channel.access_version) !== String(expectedAccessVersion))
    )
      return false;
    // All deletion paths lock the channel before its messages, matching live
    // writes and the counter trigger. Expiry must not invert that lock order.
    await tx.query(
      `DELETE FROM context_messages WHERE connection_id=$1 AND channel_id=$2 AND message_id IN
      (SELECT message_id FROM context_messages WHERE connection_id=$1 AND channel_id=$2
        AND sent_at<now()-make_interval(days=>$3) ORDER BY sent_at LIMIT 1000)`,
      [connectionId, channelId, retentionDays()],
    );
    for (const message of messages.slice(0, 100)) {
      if (
        message.channelId !== channelId ||
        !message.id ||
        !Number.isFinite(message.version) ||
        !Number.isFinite(Date.parse(message.sentAt))
      )
        continue;
      if (
        Date.parse(message.sentAt) < Date.now() - retentionDays() * 86400_000 &&
        !message.deleted
      )
        continue;
      await tx.query(
        `INSERT INTO context_messages(connection_id,channel_id,message_id,author_id,author_name,body,url,thread_id,sent_at,source_version,deleted)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(connection_id,channel_id,message_id) DO UPDATE SET author_id=excluded.author_id,author_name=excluded.author_name,
          body=excluded.body,url=excluded.url,thread_id=excluded.thread_id,source_version=excluded.source_version,deleted=excluded.deleted
        WHERE NOT context_messages.deleted AND context_messages.source_version<=excluded.source_version`,
        [
          connectionId,
          channelId,
          message.id,
          message.authorId,
          message.authorName.slice(0, 200),
          message.deleted ? "" : message.body.slice(0, 16000),
          message.url,
          message.threadId ?? null,
          message.sentAt,
          message.version,
          !!message.deleted,
        ],
      );
    }
    if (verified)
      await tx.query(
        "UPDATE context_channels SET verified_at=now(),synced_at=now(),error=NULL WHERE connection_id=$1 AND channel_id=$2",
        [connectionId, channelId],
      );
    // Prune only overflow. The counter is maintained by INSERT/DELETE triggers,
    // so the hot event path never scans all 10,000 retained rows.
    const count = (
      await tx.query<{ stored_messages: number }>(
        "SELECT stored_messages FROM context_channels WHERE connection_id=$1 AND channel_id=$2",
        [connectionId, channelId],
      )
    ).rows[0].stored_messages;
    if (count > 10000)
      await tx.query(
        `DELETE FROM context_messages WHERE connection_id=$1 AND channel_id=$2 AND message_id IN
      (SELECT message_id FROM context_messages WHERE connection_id=$1 AND channel_id=$2 ORDER BY sent_at ASC,message_id ASC LIMIT $3)`,
        [connectionId, channelId, count - 10000],
      );
    return true;
  });
}
export function retentionDays() {
  const days = Number(process.env.TEAM_CONTEXT_RETENTION_DAYS ?? 30);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : 30;
}
export async function deliverSourceMessage(
  provider: TeamProvider,
  externalId: string,
  message: SourceMessage,
) {
  const selected = await query<{ id: string }>(
    `SELECT c.id FROM context_connections c JOIN context_channels ch ON ch.connection_id=c.id
    WHERE c.provider=$1 AND c.external_id=$2 AND ch.channel_id=$3`,
    [provider, externalId, message.channelId],
  );
  for (const connection of selected)
    await saveSourceMessages(connection.id, message.channelId, [message]);
}
export async function invalidateSource(
  provider: TeamProvider,
  externalId: string,
  channelId?: string,
) {
  await query(
    `UPDATE context_channels ch SET verified_at=NULL,access_version=access_version+1,error='Channel access changed. Waiting for verification.',next_sync_at=now()
    FROM context_connections c WHERE c.id=ch.connection_id AND c.provider=$1 AND c.external_id=$2 AND ($3::text IS NULL OR ch.channel_id=$3)`,
    [provider, externalId, channelId ?? null],
  );
}
