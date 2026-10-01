import { withApiLimit } from "../../../../lib/http/api-limit";
import { orgAccess, orgDenied } from "../../../../lib/org/auth";
import { orgUsage, type OrgUsage } from "../../../../lib/ai/usage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type OrgUsageResponse = OrgUsage;

/** The org's pooled AI-run usage against its limits. Any member may see it. */
async function handleGET(_request: Request, context: RouteContext<"/api/orgs/[slug]/usage">) {
  const { slug } = await context.params;
  const result = await orgAccess(slug);
  const refusal = orgDenied(result);
  if (refusal || !result) return refusal!;

  const usage = await orgUsage(result.org.id);
  return Response.json(usage satisfies OrgUsageResponse, {
    headers: { "cache-control": "no-store" },
  });
}

export const GET = withApiLimit("/api/orgs/[slug]/usage", handleGET);
