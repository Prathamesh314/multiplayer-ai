import { withApiLimit } from "../../../../lib/http/api-limit";
import { currentUser } from "../../../../lib/auth/tokens";
import { acceptInvitationById } from "../../../../lib/org/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Accept a connect-code invitation the caller was named in. */
async function handlePOST(_request: Request, context: RouteContext<"/api/invitations/[id]/accept">) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  const { id } = await context.params;
  const result = await acceptInvitationById(id, user.id);
  if (!result.ok) return Response.json({ error: result.error }, { status: 409 });

  return Response.json({ orgSlug: result.orgSlug }, { status: 200 });
}

export const POST = withApiLimit("/api/invitations/[id]/accept", handlePOST);
