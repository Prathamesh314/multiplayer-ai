import { withApiLimit } from "../../../lib/http/api-limit";
import { currentUser } from "../../../lib/auth/tokens";
import { acceptInvitationByToken } from "../../../lib/org/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Accept an email invitation by its one-time link token. */
async function handlePOST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  let body: { token?: string };
  try {
    body = (await request.json()) as { token?: string };
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  const token = String(body.token ?? "").trim();
  if (!token) return Response.json({ error: "Missing invitation token." }, { status: 400 });

  const result = await acceptInvitationByToken(token, user.id);
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });

  return Response.json({ orgSlug: result.orgSlug }, { status: 200 });
}

export const POST = withApiLimit("/api/invitations/accept", handlePOST);
