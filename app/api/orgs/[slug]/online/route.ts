import { withApiLimit } from "../../../../lib/http/api-limit";
import { orgAccess, orgDenied } from "../../../../lib/org/auth";
import { listOrgMembers } from "../../../../lib/org/store";
import { presence } from "../../../../lib/presence";
import type { OrgOnlineResponse } from "../../../../lib/org/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who in the org has the app open right now (a heartbeat in the last 45s from
 * any of its pages). Only the org's active members can be listed, and only to
 * another member: a heartbeat naming an org never puts an outsider here.
 */
async function handleGET(_request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  const online = new Set(await (await presence()).onlineInOrg(result.org.id));
  const people = (await listOrgMembers(result.org.id))
    .filter((member) => member.status === "active" && online.has(member.userId))
    .map(({ userId, handle, displayName, avatarUrl }) => ({ userId, handle, displayName, avatarUrl, isSelf: userId === result.user.id }));
  return Response.json({ people } satisfies OrgOnlineResponse, { headers: { "cache-control": "no-store" } });
}

export const GET = withApiLimit("/api/orgs/[slug]/online", handleGET);
