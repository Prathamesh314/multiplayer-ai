import { withApiLimit } from "../../lib/http/api-limit";
import { currentUser } from "../../lib/auth/tokens";
import { listMyHandoffs, type InboxHandoff } from "../../lib/ai/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type HandoffInboxResponse = { received: InboxHandoff[]; sent: InboxHandoff[] };

/** The signed-in member's handoffs across every room: offered to them, and offered by them. */
async function handleGET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  return Response.json((await listMyHandoffs(user.id)) satisfies HandoffInboxResponse, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiLimit("/api/handoffs", handleGET);
