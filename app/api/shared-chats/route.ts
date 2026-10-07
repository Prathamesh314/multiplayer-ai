import { withApiLimit } from "../../lib/http/api-limit";
import { listSharedChats } from "../../lib/sharing/store";
import { sharingResponse, sharingUser } from "../../lib/sharing/http";
export const runtime = "nodejs";
export const GET = withApiLimit("/api/shared-chats", async () => sharingResponse(async () => ({chats:await listSharedChats((await sharingUser()).id)})));
