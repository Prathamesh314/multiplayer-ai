import { withApiLimit } from "../../../../lib/http/api-limit";
import { orgAccess, orgDenied } from "../../../../lib/org/auth";
import { listOrgMembers } from "../../../../lib/org/store";
import type { OrgMembersResponse } from "../../../../lib/org/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The org roster. Any member may see who else is in the org. */
async function handleGET(_request: Request, context: RouteContext<"/api/orgs/[slug]/members">) {
  const { slug } = await context.params;
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  const members = await listOrgMembers(result.org.id);
  return Response.json({ members } satisfies OrgMembersResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/orgs/[slug]/members", handleGET);
