import { grantSessionKey, readSessionKeys } from "../../lib/session/cookie";
import { createSession, listSessions, publicSession } from "../../lib/session/store";
import type { CreateSessionRequest, SessionListResponse } from "../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sessions this browser holds a key for. Others are invisible here. */
export async function GET() {
  const keys = await readSessionKeys();
  const sessions = listSessions(Object.keys(keys))
    .filter((session) => keys[session.id] === session.key)
    .map(publicSession);

  return Response.json({ sessions } satisfies SessionListResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  let body: CreateSessionRequest = {};
  try {
    body = (await request.json()) as CreateSessionRequest;
  } catch {
    // An empty body is fine; the session gets a generated name.
  }

  const session = createSession(body.name);
  await grantSessionKey(session.id, session.key);

  return Response.json(publicSession(session), { status: 201 });
}
