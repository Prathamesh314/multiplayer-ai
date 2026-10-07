import { withApiLimit } from "../../../lib/http/api-limit";
import { sharingResponse, sharingUser } from "../../../lib/sharing/http";
import { listGuestAccessRequests } from "../../../lib/collaboration/promotion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withApiLimit("/api/collaboration/access-requests", async (request: Request) => sharingResponse(async () => {
  const user = await sharingUser();
  return listGuestAccessRequests(user.id, Number(new URL(request.url).searchParams.get("offset") ?? 0));
}));
