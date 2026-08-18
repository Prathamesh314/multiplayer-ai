import { currentUser } from "../../lib/auth/tokens";
import { presence, HEARTBEAT_MS, TTL_MS } from "../../lib/presence";
import { roleOf } from "../../lib/session/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type HeartbeatRequest = {
  /** Stable per browser tab, generated on the client. */
  connectionId: string;
  sessionId?: string | null;
  orgId?: string | null;
};

export type HeartbeatResponse = {
  /** How long the client should wait before reporting in again. */
  intervalMs: number;
  /** Everyone currently in the same session, this account included. */
  online: string[];
};

/**
 * One heartbeat per open tab. The response carries the interval so the cadence
 * is the server's decision, not something baked into the bundle.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

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

  const store = await presence();
  await store.heartbeat(body.connectionId, {
    userId: user.id,
    sessionId,
    orgId: typeof body.orgId === "string" ? body.orgId : null,
  });

  return Response.json(
    {
      intervalMs: HEARTBEAT_MS,
      online: sessionId ? await store.onlineInSession(sessionId) : [],
    } satisfies HeartbeatResponse,
    { headers: { "cache-control": "no-store" } },
  );
}

/** Explicit goodbye. An optimisation — the {TTL} window cleans up regardless. */
export async function DELETE(request: Request) {
  const connectionId = new URL(request.url).searchParams.get("connectionId");
  if (!connectionId) return Response.json({ error: "A connectionId is required." }, { status: 400 });

  await (await presence()).disconnect(connectionId);
  return Response.json({ disconnected: true, ttlMs: TTL_MS });
}
