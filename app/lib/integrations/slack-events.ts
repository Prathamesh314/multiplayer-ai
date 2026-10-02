import { createHmac, timingSafeEqual } from "node:crypto";
import { deliverSourceMessage, invalidateSource } from "./store";
import { slackMessage } from "./providers";

export function verifySlack(
  raw: string,
  timestamp: string,
  signature: string,
  secret = process.env.SLACK_SIGNING_SECRET ?? "",
  now = Date.now(),
) {
  if (
    !secret ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !/^v0=[a-f\d]{64}$/i.test(signature)
  )
    return false;
  const expected =
    "v0=" +
    createHmac("sha256", secret).update(`v0:${timestamp}:${raw}`).digest("hex");
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
export async function slackEvent(payload: Record<string, unknown>) {
  const team = payload.team_id;
  if (
    typeof team !== "string" ||
    !payload.event ||
    typeof payload.event !== "object"
  )
    return;
  const event = payload.event as Record<string, unknown>;
  if (["app_uninstalled", "tokens_revoked"].includes(String(event.type))) {
    await invalidateSource("slack", team);
    return;
  }
  if (
    [
      "channel_deleted",
      "channel_archive",
      "channel_left",
      "member_left_channel",
      "channel_id_changed",
    ].includes(String(event.type))
  ) {
    await invalidateSource(
      "slack",
      team,
      typeof event.channel === "string" ? event.channel : undefined,
    );
    return;
  }
  if (event.type !== "message" || typeof event.channel !== "string") return;
  const channel = event.channel;
  if (
    event.subtype === "message_deleted" &&
    typeof event.deleted_ts === "string"
  ) {
    await deliverSourceMessage("slack", team, {
      ...slackMessage(
        team,
        channel,
        { ts: event.deleted_ts },
        Number(event.event_ts ?? event.ts) * 1000,
      ),
      deleted: true,
    });
    return;
  }
  const source = event.subtype === "message_changed" ? event.message : event;
  if (!source || typeof source !== "object") return;
  const message = source as Record<string, unknown>;
  if (
    typeof message.ts !== "string" ||
    !/^\d+\.\d+$/.test(message.ts) ||
    typeof message.text !== "string"
  )
    return;
  await deliverSourceMessage(
    "slack",
    team,
    slackMessage(
      team,
      channel,
      {
        ts: message.ts,
        text: message.text,
        user: typeof message.user === "string" ? message.user : undefined,
        bot_id: typeof message.bot_id === "string" ? message.bot_id : undefined,
        thread_ts:
          typeof message.thread_ts === "string" ? message.thread_ts : undefined,
      },
      Number(event.event_ts ?? event.ts ?? message.ts) * 1000,
    ),
  );
}
