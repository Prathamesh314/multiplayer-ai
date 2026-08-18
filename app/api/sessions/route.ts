import { currentUser } from "../../lib/auth/tokens";
import { createRepo, gitAvailable } from "../../lib/session/repo";
import { sweepInBackground } from "../../lib/session/retention";
import { createSession, listSessionsForUser } from "../../lib/session/store";
import type { CreateSessionRequest, SessionListResponse } from "../../lib/session/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sessions this account may open. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  // No scheduler exists in this app, so the session list is what drives
  // retention. It is throttled and never awaited.
  sweepInBackground();

  const sessions = await listSessionsForUser(user.id);
  return Response.json({ sessions } satisfies SessionListResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

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

  const session = await createSession(user.id, body.name);

  // The repo is created up front so seeding has somewhere to land, and so a
  // session that is never seeded still fails loudly rather than half-existing.
  await createRepo(session.id);

  return Response.json(session, { status: 201 });
}
