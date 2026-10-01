import { withApiLimit } from "../../lib/http/api-limit";
import { currentUser } from "../../lib/auth/tokens";
import { listPendingInvitations } from "../../lib/org/store";
import type { PendingInvitationsResponse } from "../../lib/org/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Connect-code invitations awaiting the caller's acceptance. */
async function handleGET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });

  const invitations = await listPendingInvitations(user.id);
  return Response.json({ invitations } satisfies PendingInvitationsResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/invitations", handleGET);
