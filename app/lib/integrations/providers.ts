import { callbackUrl, unseal } from "./config";
import {
  IntegrationError,
  type Connection,
  type SourceChannel,
  type SourceMessage,
  type TeamAdapter,
  type TeamProvider,
} from "./types";

export async function providerJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new IntegrationError(
      "The chat service could not be reached. Try again shortly.",
      502,
    );
  }
  if (!response.ok)
    throw new IntegrationError(
      response.status === 429
        ? "The chat service is rate limiting requests. Sync will retry automatically."
        : "The chat service refused access. Check the connection and channel permissions.",
      response.status === 429 ? 429 : 403,
      Math.min(
        3600,
        Math.max(60, Number(response.headers.get("retry-after")) || 60),
      ),
    );
  return response.json() as Promise<T>;
}
const token = (connection: Connection) =>
  unseal(
    connection.credential,
    `${connection.provider}:${connection.project_id}`,
  );
type SlackMessage = {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  edited?: { ts: string };
  user_profile?: { display_name?: string; real_name?: string };
};
type SlackChannel = {
  id: string;
  name: string;
  is_member: boolean;
  is_private: boolean;
  is_archived: boolean;
};
type SlackReply = {
  ok: boolean;
  error?: string;
  access_token?: string;
  refresh_token?: string;
  team?: { id: string; name: string };
  channels?: SlackChannel[];
  channel?: SlackChannel;
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
};
async function slack(
  method: string,
  accessToken: string,
  params: Record<string, string> = {},
) {
  const result = await providerJson<SlackReply>(
    `https://slack.com/api/${method}?${new URLSearchParams(params)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!result.ok)
    throw new IntegrationError(
      "Slack access is unavailable. Check the app scopes and invite the app to this public channel.",
      403,
    );
  return result;
}
export function slackMessage(
  team: string,
  channel: string,
  message: SlackMessage,
  version?: number,
): SourceMessage {
  return {
    id: message.ts,
    channelId: channel,
    authorId: message.user ?? message.bot_id ?? "unknown",
    authorName:
      message.user_profile?.display_name ||
      message.user_profile?.real_name ||
      message.user ||
      message.bot_id ||
      "Unknown",
    body: message.text ?? "",
    threadId: message.thread_ts !== message.ts ? message.thread_ts : undefined,
    sentAt: new Date(Number(message.ts) * 1000).toISOString(),
    version: version ?? Number(message.edited?.ts ?? message.ts) * 1000,
    url: `https://app.slack.com/client/${team}/${channel}?message_ts=${encodeURIComponent(message.ts)}`,
  };
}
const slackAdapter: TeamAdapter = {
  authorize(state) {
    return `https://slack.com/oauth/v2/authorize?${new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID!,
      scope: "channels:read,channels:history",
      redirect_uri: callbackUrl("slack"),
      state,
    })}`;
  },
  async exchange(code) {
    const result = await providerJson<SlackReply>(
      "https://slack.com/api/oauth.v2.access",
      {
        method: "POST",
        body: new URLSearchParams({
          code,
          client_id: process.env.SLACK_CLIENT_ID!,
          client_secret: process.env.SLACK_CLIENT_SECRET!,
          redirect_uri: callbackUrl("slack"),
        }),
      },
    );
    if (!result.ok || !result.access_token || !result.team?.id)
      throw new IntegrationError(
        "Slack did not complete the connection. Try connecting again.",
      );
    if (result.refresh_token)
      throw new IntegrationError(
        "This integration currently requires Slack token rotation to be disabled in the app configuration.",
      );
    return {
      externalId: result.team.id,
      name: result.team.name,
      token: result.access_token,
    };
  },
  async channels(connection) {
    const result: SourceChannel[] = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const data = await slack("conversations.list", token(connection), {
        types: "public_channel",
        exclude_archived: "true",
        limit: "200",
        cursor,
      });
      result.push(
        ...(data.channels ?? [])
          .filter((c) => c.is_member && !c.is_private && !c.is_archived)
          .map((c) => ({
            id: c.id,
            name: c.name,
            url: `https://app.slack.com/client/${connection.external_id}/${c.id}`,
          })),
      );
      cursor = data.response_metadata?.next_cursor ?? "";
      if (!cursor) return result;
    }
    throw new IntegrationError(
      "This workspace exceeds the channel directory limit. Contact the server administrator.",
    );
  },
  async history(connection, channel) {
    const accessToken = token(connection);
    const info = (
      await slack("conversations.info", accessToken, { channel: channel.id })
    ).channel;
    if (!info?.is_member || info.is_private || info.is_archived)
      throw new IntegrationError(
        "The app no longer has access to this public channel.",
        403,
      );
    const data = await slack("conversations.history", accessToken, {
      channel: channel.id,
      limit: "15",
    });
    return {
      channel: { ...channel, name: info.name },
      messages: (data.messages ?? []).map((message) =>
        slackMessage(connection.external_id, channel.id, message),
      ),
    };
  },
};

type DiscordChannel = {
  id: string;
  guild_id?: string;
  name: string;
  type: number;
  permission_overwrites?: { id: string; allow: string; deny: string }[];
};
type DiscordRole = { id: string; permissions: string };
export type DiscordMessage = {
  id: string;
  channel_id: string;
  content?: string;
  timestamp: string;
  edited_timestamp?: string | null;
  author?: { id: string; username: string; global_name?: string | null };
  message_reference?: { message_id?: string };
};
const READ = 1024n | 65536n;
export function publicDiscordChannel(
  channel: DiscordChannel,
  guildId: string,
  roles: DiscordRole[],
) {
  let permissions = BigInt(
    roles.find((role) => role.id === guildId)?.permissions ?? "0",
  );
  const overwrite = channel.permission_overwrites?.find(
    (item) => item.id === guildId,
  );
  if (overwrite)
    permissions =
      (permissions & ~BigInt(overwrite.deny)) | BigInt(overwrite.allow);
  return channel.type === 0 && (permissions & READ) === READ;
}
const discord = <T>(path: string) =>
  providerJson<T>(`https://discord.com/api/v10${path}`, {
    headers: { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
  });
export function discordMessage(
  guild: string,
  message: DiscordMessage,
): SourceMessage {
  return {
    id: message.id,
    channelId: message.channel_id,
    body: message.content ?? "",
    authorId: message.author?.id ?? "unknown",
    authorName:
      message.author?.global_name || message.author?.username || "Unknown",
    sentAt: message.timestamp,
    version: Date.parse(message.edited_timestamp || message.timestamp),
    threadId: message.message_reference?.message_id,
    url: `https://discord.com/channels/${guild}/${message.channel_id}/${message.id}`,
  };
}
const discordAdapter: TeamAdapter = {
  authorize(state) {
    return `https://discord.com/oauth2/authorize?${new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID!,
      scope: "bot identify",
      permissions: READ.toString(),
      response_type: "code",
      integration_type: "0",
      redirect_uri: callbackUrl("discord"),
      state,
    })}`;
  },
  async exchange(code) {
    const data = await providerJson<{ guild?: { id: string; name: string } }>(
      "https://discord.com/api/v10/oauth2/token",
      {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: process.env.DISCORD_CLIENT_ID!,
          client_secret: process.env.DISCORD_CLIENT_SECRET!,
          redirect_uri: callbackUrl("discord"),
        }),
      },
    );
    // Never trust the guild_id query parameter: it is only a browser hint.
    if (!data.guild?.id)
      throw new IntegrationError(
        "Enable Require OAuth2 Code Grant in the Discord app, then reconnect.",
      );
    const guild = await discord<{ id: string; name: string }>(
      `/guilds/${data.guild.id}`,
    );
    return { externalId: guild.id, name: guild.name, token: "server-bot" };
  },
  async channels(connection) {
    const [channels, roles] = await Promise.all([
      discord<DiscordChannel[]>(`/guilds/${connection.external_id}/channels`),
      discord<DiscordRole[]>(`/guilds/${connection.external_id}/roles`),
    ]);
    return channels
      .filter((channel) =>
        publicDiscordChannel(channel, connection.external_id, roles),
      )
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        url: `https://discord.com/channels/${connection.external_id}/${channel.id}`,
      }));
  },
  async history(connection, channel) {
    const available = await this.channels(connection);
    if (!available.some((item) => item.id === channel.id))
      throw new IntegrationError(
        "This channel is no longer public or accessible.",
        403,
      );
    const messages = await discord<DiscordMessage[]>(
      `/channels/${channel.id}/messages?limit=50`,
    );
    return {
      channel: available.find((item) => item.id === channel.id)!,
      messages: messages.map((message) =>
        discordMessage(connection.external_id, message),
      ),
    };
  },
};
const adapters: Record<TeamProvider, TeamAdapter> = {
  slack: slackAdapter,
  discord: discordAdapter,
};
export const adapterFor = (provider: TeamProvider): TeamAdapter =>
  adapters[provider];
