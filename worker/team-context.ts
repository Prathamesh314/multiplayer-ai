import { Client, GatewayIntentBits, Options, Routes } from "discord.js";
import { query } from "../app/lib/db/client";
import {
  deliverSourceMessage,
  invalidateSource,
} from "../app/lib/integrations/store";
import {
  discordMessage,
  type DiscordMessage,
} from "../app/lib/integrations/providers";
import { syncNextChannel } from "../app/lib/integrations/sync";

/** One gateway in the background worker, shared by all connected projects.
 * Web replicas never open gateway connections or cache message histories. */
export function startTeamContext() {
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    retry: ReturnType<typeof setTimeout> | undefined;
  let syncing = Promise.resolve();
  const pending = new Set<Promise<void>>();
  let selectedChannels = new Set<string>();
  let tail = Promise.resolve(),
    restarting = false;
  const client = process.env.DISCORD_BOT_TOKEN
    ? new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
        ],
        makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
      })
    : null;
  const tick = () => {
    syncing = (async () => {
      try {
        if (client) {
          const selected = await query<{
            external_id: string;
            channel_id: string;
          }>(
            `SELECT c.external_id,ch.channel_id FROM context_connections c JOIN context_channels ch ON ch.connection_id=c.id WHERE c.provider='discord'`,
          );
          selectedChannels = new Set(
            selected.map((row) => `${row.external_id}:${row.channel_id}`),
          );
        }
        await syncNextChannel();
      } catch {
        console.warn("Team context sync is temporarily unavailable.");
      }
      if (!stopped) timer = setTimeout(tick, 5000);
    })();
  };
  tick();
  if (client) {
    client.on("error", () =>
      console.warn(
        "Discord connection needs attention; check bot configuration.",
      ),
    );
    client.on("shardDisconnect", () => {
      void query(
        `UPDATE context_channels SET verified_at=NULL,access_version=access_version+1 WHERE connection_id IN (SELECT id FROM context_connections WHERE provider='discord')`,
      ).catch(() => {});
    });
    client.on("raw", (packet) => {
      if (stopped || restarting) return;
      if (packet.t?.startsWith("MESSAGE_")) {
        const source = packet.d as unknown as {
          guild_id?: string;
          channel_id?: string;
        };
        // Cheap admission only: the write path still rechecks current selection.
        // Unselected guild traffic never fills the queue or issues per-message SQL.
        if (!selectedChannels.has(`${source.guild_id}:${source.channel_id}`))
          return;
      }
      if (
        !packet.t ||
        ![
          "MESSAGE_CREATE",
          "MESSAGE_UPDATE",
          "MESSAGE_DELETE",
          "MESSAGE_DELETE_BULK",
          "CHANNEL_DELETE",
          "CHANNEL_UPDATE",
          "GUILD_DELETE",
          "GUILD_ROLE_UPDATE",
          "GUILD_ROLE_DELETE",
        ].includes(packet.t)
      )
        return;
      // Serialize gateway event handling to preserve provider order. REST has
      // its own backpressure/retry handling in discord.js.
      const work = tail
        .then(async () => {
          const data = packet.d as unknown as Record<string, unknown>;
          const guild =
            typeof data.guild_id === "string"
              ? data.guild_id
              : packet.t === "GUILD_DELETE"
                ? String(data.id)
                : null;
          if (!guild) return;
          const channel = String(data.channel_id ?? data.id ?? "");
          if (!packet.t!.startsWith("MESSAGE_")) {
            await invalidateSource(
              "discord",
              guild,
              packet.t!.startsWith("CHANNEL_") ? channel : undefined,
            );
            return;
          }
          // Ignore DMs, unselected channels and thread channels before fetching.
          const selected = await query(
            `SELECT 1 FROM context_channels ch JOIN context_connections c ON c.id=ch.connection_id
          WHERE c.provider='discord' AND c.external_id=$1 AND ch.channel_id=$2 LIMIT 1`,
            [guild, channel],
          );
          if (!selected.length) return;
          if (
            packet.t === "MESSAGE_DELETE" ||
            packet.t === "MESSAGE_DELETE_BULK"
          ) {
            const ids = Array.isArray(data.ids) ? data.ids : [data.id];
            for (const id of ids)
              if (typeof id === "string" && /^\d+$/.test(id))
                await deliverSourceMessage("discord", guild, {
                  id,
                  channelId: channel,
                  authorId: "unknown",
                  authorName: "Unknown",
                  body: "",
                  url: `https://discord.com/channels/${guild}/${channel}/${id}`,
                  sentAt: new Date(
                    Number((BigInt(id) >> 22n) + 1420070400000n),
                  ).toISOString(),
                  version: Date.now(),
                  deleted: true,
                });
          } else {
            if (
              packet.t === "MESSAGE_UPDATE" &&
              typeof data.content !== "string"
            )
              return;
            const message =
              packet.t === "MESSAGE_UPDATE"
                ? ((await client.rest.get(
                    Routes.channelMessage(channel, String(data.id)),
                  )) as DiscordMessage)
                : (data as unknown as DiscordMessage);
            await deliverSourceMessage(
              "discord",
              guild,
              discordMessage(guild, message),
            );
          }
        })
        .catch(async () => {
          console.warn(
            "Discord context event could not be saved; scheduling reconciliation.",
          );
          await query(
            `UPDATE context_channels SET verified_at=NULL,access_version=access_version+1,next_sync_at=now() WHERE connection_id IN (SELECT id FROM context_connections WHERE provider='discord')`,
          ).catch(() => {});
        })
        .finally(() => pending.delete(work));
      tail = work;
      pending.add(work);
      // Bound memory under a database outage instead of retaining every frame.
      if (pending.size >= 500) {
        restarting = true;
        client.destroy();
        void work.finally(() => {
          restarting = false;
          if (!stopped) retry = setTimeout(() => void login(), 30_000);
        });
      }
    });
    const login = async () => {
      if (stopped) return;
      try {
        await client.login(process.env.DISCORD_BOT_TOKEN);
      } catch {
        console.warn(
          "Discord is not connected. Check the bot token and Message Content intent.",
        );
        if (!stopped) retry = setTimeout(() => void login(), 30_000);
      }
    };
    void login();
  }
  return async () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(retry);
    client?.destroy();
    await syncing;
    await Promise.allSettled([...pending]);
  };
}
