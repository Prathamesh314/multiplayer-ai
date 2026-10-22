import { withApiLimit } from "../../lib/http/api-limit";
import { currentUser } from "../../lib/auth/tokens";
import { presence, HEARTBEAT_MS, TTL_MS } from "../../lib/presence";
import { roleOf } from "../../lib/session/store";
import { queryOne } from "../../lib/db/client";
import { events } from "../../lib/events";
import type { PresenceChange } from "../../lib/presence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type HeartbeatRequest = {
  /** Stable per browser tab, generated on the client. */
  connectionId: string;
  sessionId?: string | null;
  orgId?: string | null;
  /** The chat this tab has open, if any. */
  runId?: string | null;
};

export type HeartbeatResponse = {
  /** How long the client should wait before reporting in again. */
  intervalMs: number;
  /** Everyone currently in the same session, this account included. */
  online: string[];
  /** Everyone with the same chat open, this account included. */
  viewers: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tell the rooms involved, so their viewer lists update now rather than at the next beat. */
async function announce(change: PresenceChange) {
  if (!change.changed || !change.sessionIds.length) return;
  const bus = await events();
  await Promise.all(change.sessionIds.map((id) => bus.publish(id, { type: "presence.changed", at: Date.now() }).catch(() => {})));
}

/**
 * One heartbeat per open tab. The response carries the interval so the cadence
 * is the server's decision, not something baked into the bundle.
 */
async function handlePOST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  // A closing page's goodbye: sendBeacon can only POST.
  if (new URL(request.url).searchParams.get("leave") === "1") return handleDELETE(request);

  let body: HeartbeatRequest;
  try {
    body = (await request.json()) as HeartbeatRequest;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (typeof body.connectionId !== "string" || body.connectionId.length < 8) {
    return Response.json({ error: "A connectionId is required." }, { status: 400 });
  }

  // Presence must never imply access: a session id is only recorded once the
  // roster confirms this account belongs there.
  let sessionId: string | null = null;
  if (typeof body.sessionId === "string" && body.sessionId.length > 0) {
    sessionId = (await roleOf(body.sessionId, user.id)) ? body.sessionId : null;
  }

  // Likewise a chat: only one in that room that this account can see.
  let runId: string | null = null;
  if (sessionId && typeof body.runId === "string" && UUID.test(body.runId)) {
    const visible = await queryOne(`SELECT 1 FROM agent_runs WHERE id = $1 AND session_id = $2 AND NOT agent_run_hidden(id, $3)`, [body.runId, sessionId, user.id]);
    runId = visible ? body.runId.toLowerCase() : null;
  }

  const store = await presence();
  await announce(await store.heartbeat(body.connectionId, {
    userId: user.id,
    sessionId,
    orgId: typeof body.orgId === "string" ? body.orgId : null,
    runId,
  }));

  return Response.json(
    {
      intervalMs: HEARTBEAT_MS,
      online: sessionId ? await store.onlineInSession(sessionId) : [],
      viewers: runId ? await store.onlineInRun(runId) : [],
    } satisfies HeartbeatResponse,
    { headers: { "cache-control": "no-store" } },
  );
}

/** Explicit goodbye. An optimisation — the {TTL} window cleans up regardless. */
async function handleDELETE(request: Request) {
  const connectionId = new URL(request.url).searchParams.get("connectionId");
  if (!connectionId) return Response.json({ error: "A connectionId is required." }, { status: 400 });

  await announce(await (await presence()).disconnect(connectionId));
  return Response.json({ disconnected: true, ttlMs: TTL_MS });
}

export const POST = withApiLimit("/api/presence", handlePOST);
export const DELETE = withApiLimit("/api/presence", handleDELETE);
