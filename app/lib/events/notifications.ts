import { queryOne } from "../db/client";
import { events } from "./index";

export async function notifyUsage(sessionId: string) {
  try {
    const room = await queryOne<{ org_id: string | null }>(`SELECT org_id FROM sessions WHERE id=$1`, [sessionId]);
    if (room?.org_id) await (await events()).publish(`org:${room.org_id}`, { type: "usage.changed", at: Date.now() });
  } catch { /* Reconnection refreshes the authoritative state. */ }
}
