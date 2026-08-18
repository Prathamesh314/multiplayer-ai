import { grantSessionKey, readSessionKeys } from "../../lib/session/cookie";
import { createSession, listSessions, publicSession } from "../../lib/session/store";
import { createRepo, gitAvailable } from "../../lib/session/repo";
import { sweepInBackground } from "../../lib/session/retention";
import type { CreateSessionRequest, SessionListResponse } from "../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sessions this browser holds a key for. Others are invisible here. */
export async function GET() {
  // No scheduler exists in this app, so the session list is what drives
  // retention. It is throttled and never awaited.
  sweepInBackground();

  const keys = await readSessionKeys();
  const sessions = (await listSessions(Object.keys(keys)))
    .filter((session) => keys[session.id] === session.key)
    .map(publicSession);

  return Response.json({ sessions } satisfies SessionListResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  if (!(await gitAvailable())) {
    return Response.json(
      { error: "git is not installed on the server, so sessions cannot be created." },
      { status: 503 },
    );
  }

  let body: CreateSessionRequest = {};
  try {
    body = (await request.json()) as CreateSessionRequest;
  } catch {
    // An empty body is fine; the session gets a generated name.
  }

  const outcome = await createSession(body.name);
  if (!outcome.ok) return Response.json({ error: outcome.error }, { status: 409 });

  // The repo is created up front so seeding has somewhere to land, and so a
  // session that is never seeded still fails loudly rather than half-existing.
  await createRepo(outcome.session.id);
  await grantSessionKey(outcome.session.id, outcome.session.key);

  return Response.json(publicSession(outcome.session), { status: 201 });
}
